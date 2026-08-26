#!/usr/bin/env node
// reservation-lp 非破壊監視チェック。読み取り専用のみ。DB書き込み・Vercel設定変更・
// デプロイ・ロールバックは絶対に行わない。

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const STATE_PATH = path.resolve('last-status.json');
const LOG_PATH = path.resolve('status-log.jsonl');

const PUBLIC_URLS = {
  main: 'https://reservation-lp.vercel.app',
  alias1: 'https://reservation-lp-shingo45bc-1061s-projects.vercel.app',
  alias2: 'https://reservation-lp-git-main-shingo45bc-1061s-projects.vercel.app',
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID;
const VERCEL_PROJECT_ID = process.env.VERCEL_PROJECT_ID;

const nowIso = () => new Date().toISOString();

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
  } catch {
    return { updated_at: null, checks: {} };
  }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(t);
  }
}

// ①公開URL死活確認: main は 200、alias は 302(Deployment Protectionへのリダイレクト)が正常
async function checkUptime() {
  const detail = {};
  let ok = true;
  for (const [key, url] of Object.entries(PUBLIC_URLS)) {
    try {
      const res = await fetchWithTimeout(url);
      const status = res.status;
      const expectedOk = key === 'main' ? status === 200 : status === 302 || status === 200;
      detail[url] = { http_status: status };
      if (!expectedOk) ok = false;
    } catch (e) {
      detail[url] = { error: String(e.message || e) };
      ok = false;
    }
  }
  return { ok, detail };
}

// ②主要ページ表示確認: "/" と "/admin" の期待要素+コンソールエラー(favicon 404は無視)
async function checkKeyPages() {
  const detail = {};
  let ok = true;
  const browser = await chromium.launch();
  try {
    for (const p of ['/', '/admin']) {
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' && !msg.text().includes('favicon.ico')) {
          errors.push(msg.text());
        }
      });
      try {
        await page.goto(PUBLIC_URLS.main + p, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const text = await page.content();
        const expectedFound =
          p === '/' ? text.includes('予約まで、たった60秒') : text.includes('管理者ログイン');
        detail[p] = { expected_found: expectedFound, console_errors: errors };
        if (!expectedFound || errors.length > 0) ok = false;
      } catch (e) {
        detail[p] = { error: String(e.message || e) };
        ok = false;
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { ok, detail };
}

// ③Supabase read-only接続確認: anon keyでstore_settingsをSELECTするだけ(書き込み一切なし)
async function checkSupabase() {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/store_settings?select=id&limit=1`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    return { ok: res.status === 200, detail: { http_status: res.status } };
  } catch (e) {
    return { ok: false, detail: { error: String(e.message || e) } };
  }
}

// ④Vercelデプロイ失敗確認: 直近production deploymentのstateのみ参照(作成・変更は一切しない)
async function checkDeployments() {
  if (!VERCEL_TOKEN) {
    return { ok: true, skipped: true, detail: { note: 'VERCEL_TOKEN not set; check skipped' } };
  }
  try {
    const url = `https://api.vercel.com/v6/deployments?projectId=${VERCEL_PROJECT_ID}&teamId=${VERCEL_TEAM_ID}&target=production&limit=3`;
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } });
    if (res.status !== 200) return { ok: false, detail: { http_status: res.status } };
    const data = await res.json();
    const latest = data.deployments?.[0];
    return {
      ok: latest ? latest.state === 'READY' : false,
      detail: { latest_id: latest?.uid, latest_state: latest?.state },
    };
  } catch (e) {
    return { ok: false, detail: { error: String(e.message || e) } };
  }
}

const CHECK_TITLE = {
  uptime: '公開URL死活確認で異常を検知',
  key_pages: '主要ページ表示確認で異常を検知',
  supabase: 'Supabase read-only接続確認で異常を検知',
  deployments: 'Vercelデプロイ状態確認で異常を検知',
};

function causeHints(checkName) {
  switch (checkName) {
    case 'uptime':
      return [
        '原因候補: Vercelのデプロイ失敗、ドメインのDNS/SSL、Vercelプラットフォーム障害、Functionのコールドスタート遅延',
        '推奨対応(自動実行はしていません): Vercelのデプロイ履歴・ビルドログを確認してください',
      ];
    case 'key_pages':
      return [
        '原因候補: フロントのビルド不具合、環境変数未設定によるクライアント例外、Supabaseクライアント初期化失敗',
        '推奨対応(自動実行はしていません): Vercelのruntime logsと直近コミットの差分を確認してください',
      ];
    case 'supabase':
      return [
        '原因候補: Supabaseプロジェクトの一時停止(Free tier)、RLSポリシー変更、リージョン障害',
        '推奨対応(自動実行はしていません): Supabaseダッシュボードでプロジェクトstatusとstore_settingsのRLSポリシーを確認してください',
      ];
    case 'deployments':
      return [
        '原因候補: ビルドエラー(型/lint)、環境変数不足、依存解決失敗',
        '推奨対応(自動実行はしていません): 対象デプロイのビルドログを確認してください',
      ];
    default:
      return [];
  }
}

function ensureLabel() {
  try {
    execFileSync('gh', ['label', 'create', 'monitor-alert', '--color', 'B60205', '--description', 'reservation-lp monitor anomaly']);
  } catch {
    // 既に存在する場合はエラーになるが無視してよい
  }
}

function createIssue(checkName, detail) {
  const title = `[監視] ${CHECK_TITLE[checkName]}`;
  const body = [
    `検知時刻: ${nowIso()}`,
    '',
    '検知内容:',
    '```json',
    JSON.stringify(detail, null, 2),
    '```',
    '',
    ...causeHints(checkName),
    '',
    '※このIssueはGitHub Actionsによる自動監視で作成されました。DB書き込み・Vercel設定変更・デプロイ・ロールバックは一切実行していません。',
  ].join('\n');
  const out = execFileSync('gh', ['issue', 'create', '--title', title, '--body', body, '--label', 'monitor-alert'], { encoding: 'utf8' });
  const m = out.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function closeIssue(issueNumber, note) {
  try {
    execFileSync('gh', ['issue', 'comment', String(issueNumber), '--body', note]);
    execFileSync('gh', ['issue', 'close', String(issueNumber)]);
  } catch (e) {
    console.error('failed to close issue', e.message);
  }
}

async function main() {
  const state = await loadState();
  const prev = state.checks || {};

  const results = {
    uptime: await checkUptime(),
    key_pages: await checkKeyPages(),
    supabase: await checkSupabase(),
    deployments: await checkDeployments(),
  };

  const now = nowIso();
  const newChecks = {};
  let anyAnomaly = false;
  let labelEnsured = false;

  for (const [name, result] of Object.entries(results)) {
    const wasOk = prev[name] ? prev[name].status === 'OK' : true;
    const isOk = result.ok;
    let issueNumber = prev[name]?.issue_number ?? null;
    let since = prev[name]?.since ?? now;

    if (!isOk && wasOk) {
      since = now;
      anyAnomaly = true;
      try {
        if (!labelEnsured) {
          ensureLabel();
          labelEnsured = true;
        }
        issueNumber = createIssue(name, result.detail);
      } catch (e) {
        console.error(`failed to create issue for ${name}:`, e.message);
      }
    } else if (isOk && !wasOk) {
      since = now;
      if (issueNumber) {
        closeIssue(issueNumber, `復旧を確認しました (${now})`);
        issueNumber = null;
      }
    }

    newChecks[name] = {
      status: isOk ? 'OK' : 'NG',
      updated_at: now,
      since,
      issue_number: issueNumber,
      detail: result.detail,
      skipped: result.skipped || false,
    };
  }

  await fs.writeFile(STATE_PATH, JSON.stringify({ updated_at: now, checks: newChecks }, null, 2) + '\n');
  await fs.appendFile(
    LOG_PATH,
    JSON.stringify({
      ts: now,
      ...Object.fromEntries(Object.entries(newChecks).map(([k, v]) => [k, v.status])),
      anomaly: anyAnomaly,
    }) + '\n'
  );

  console.log(`reservation-lp監視: ${anyAnomaly ? '異常を検知しIssueを作成しました' : '異常なし'} (${now})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
