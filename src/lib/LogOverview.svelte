<script lang="ts">
  import { onMount } from 'svelte';
  import type { LogOverviewResponse, LogStatusItem } from './api';
  import { fetchLogOverview } from './api';

  let loading = true;
  let error: string | null = null;
  let lastFetched: Date | null = null;
  let statusItems: LogStatusItem[] = [];
  let collectLog: string | null = null;

  async function load() {
    loading = true;
    error = null;
    try {
      const res: LogOverviewResponse = await fetchLogOverview();
      statusItems = res.status_items ?? [];
      collectLog = res.collect_log ?? null;
      lastFetched = new Date();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  /** 年・秒を省略して MM/DD HH:mm で JST 表示（API がタイムゾーンなしの場合は JST として解釈） */
  function formatDatetime(iso: string | null): string {
    if (!iso) return '—';
    try {
      const normalized = iso.includes('+') || iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + '+09:00';
      const d = new Date(normalized);
      if (Number.isNaN(d.getTime())) return iso;
      const jstMs = d.getTime() + 9 * 60 * 60 * 1000;
      const jst = new Date(jstMs);
      const pad = (n: number) => String(n).padStart(2, '0');
      const m = jst.getUTCMonth() + 1;
      const day = jst.getUTCDate();
      const h = jst.getUTCHours();
      const min = jst.getUTCMinutes();
      return `${pad(m)}/${pad(day)} ${pad(h)}:${pad(min)}`;
    } catch {
      return iso;
    }
  }

  function formatHoursAgo(hours: number | null): string {
    if (hours == null) return '—';
    return `${hours} 時間前`;
  }

  function formatDaysAgo(days: number | null): string {
    if (days == null) return '—';
    return `${days} 日`;
  }

  /** 最新の取得時刻が直前の正時（直近の JST 正時）でない場合 true */
  function isLatestNotAtPreviousFullHour(latestIso: string | null): boolean {
    if (!latestIso) return false;
    const iso = latestIso.includes('+') || latestIso.endsWith('Z') ? latestIso : latestIso.replace(' ', 'T') + '+09:00';
    const latestMs = new Date(iso).getTime();
    if (Number.isNaN(latestMs)) return false;
    const jstOffsetMs = 9 * 60 * 60 * 1000;
    const jstNowMs = Date.now() + jstOffsetMs;
    const currentHourStartJstMs = Math.floor(jstNowMs / (60 * 60 * 1000)) * (60 * 60 * 1000);
    const currentHourStartUtcMs = currentHourStartJstMs - jstOffsetMs;
    return latestMs < currentHourStartUtcMs;
  }

  /** 連続（さかのぼり）が 1.1 日未満の場合 true */
  function isContinuousShort(days: number | null): boolean {
    return days != null && days < 1.1;
  }

  function statusCellClass(item: LogStatusItem): string {
    if (item.log_status === 'warning') return 'log-warn';
    if (item.log_status === 'error') return 'log-err';
    return '';
  }

  function statusLabel(item: LogStatusItem): string {
    if (item.log_status === 'warning') return 'WARN';
    if (item.log_status === 'error') return 'ERROR';
    return '正常';
  }

  onMount(load);
</script>

<section class="log-overview">
  <header class="log-header">
    <div>
      <h2>collect.log / 巡回状況</h2>
      <p class="legend">
        <strong>最新の取得</strong>＝直近1件の target_datetime。
        <strong>経過時間</strong>＝その取得が今から何時間前か（全県一括のため県どうしで同じになりやすい）。
        <strong>連続データ最古</strong>＝1時間刻みで欠けなしにさかのぼれる最古の target_datetime。
        <strong>継続時間</strong>＝その最古が今から何日前か（県ごとに異なる）。
      </p>
    </div>
    <div class="log-actions">
      <button type="button" on:click={load} disabled={loading}>
        {loading ? '取得中…' : '更新'}
      </button>
      {#if lastFetched}
        <span class="meta">最終取得: {lastFetched.toLocaleString('ja-JP')}</span>
      {/if}
    </div>
  </header>

  {#if error}
    <div class="error" role="alert">
      取得できませんでした: {error}
    </div>
  {/if}

  <div class="table-wrapper">
    <table class="status-table" aria-label="県別収集状況">
      <thead>
        <tr>
          <th>県</th>
          <th>地域</th>
          <th>最新の取得</th>
          <th>経過時間</th>
          <th>連続データ最古</th>
          <th>継続時間</th>
          <th>状態</th>
          <th>message</th>
        </tr>
      </thead>
      <tbody>
        {#if statusItems.length === 0 && !loading}
          <tr>
            <td colspan="8">データがありません。</td>
          </tr>
        {:else}
          {#each statusItems as it}
            <tr class:no-data={!it.has_data}>
              <td>
                {#if it.pref_url}
                  <a
                    href={it.pref_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="pref-link"
                  >
                    {it.name_ja}
                  </a>
                {:else}
                  {it.name_ja}
                {/if}
              </td>
              <td>{it.region}</td>
              <td class:cell-highlight={isLatestNotAtPreviousFullHour(it.latest_datetime)}>{formatDatetime(it.latest_datetime)}</td>
              <td class="hours-ago" class:cell-highlight={isLatestNotAtPreviousFullHour(it.latest_datetime)}>{formatHoursAgo(it.hours_ago)}</td>
              <td class:cell-highlight={isContinuousShort(it.continuous_days_ago)}>{formatDatetime(it.oldest_continuous_datetime)}</td>
              <td class="hours-ago" class:cell-highlight={isContinuousShort(it.continuous_days_ago)}>{formatDaysAgo(it.continuous_days_ago)}</td>
              <td class={statusCellClass(it)}>{statusLabel(it)}</td>
              <td class="log-msg" title={it.log_message ?? ''}>{it.log_message ?? '—'}</td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

  <details class="log-details">
    <summary>collect.log（クリックで展開・手動更新）</summary>
    <div class="log-meta">
      collect.log —
      <span>{collectLog ? '取得済み' : loading ? '読み込み中…' : '取得できませんでした'}</span>
    </div>
    <pre class="log-body">{collectLog ?? ''}</pre>
  </details>
</section>

<style>
  .log-overview {
    background: #1e1e1e;
    color: #d4d4d4;
    padding: 1rem;
    border-radius: 12px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  }

  .log-header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    margin-bottom: 0.75rem;
  }

  h2 {
    margin: 0 0 0.5rem 0;
    font-size: 1rem;
    color: #d4d4d4;
  }

  .legend {
    margin: 0;
    font-size: 0.85rem;
    color: #858585;
  }

  .log-actions {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
  }

  .log-actions button {
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    border: 1px solid #555;
    background: #333;
    color: #f5f5f5;
    cursor: pointer;
    font-size: 0.85rem;
  }

  .log-actions button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .log-actions button:not(:disabled):hover {
    background: #3f3f3f;
  }

  .meta {
    font-size: 0.8rem;
    color: #a0a0a0;
  }

  .error {
    margin: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: #4a1b1b;
    color: #ffb3b3;
    font-size: 0.85rem;
  }

  .table-wrapper {
    overflow-x: auto;
  }

  .status-table {
    border-collapse: collapse;
    font-size: 0.85rem;
    margin-bottom: 1rem;
    min-width: 100%;
  }

  .status-table th,
  .status-table td {
    border: 1px solid #444;
    padding: 0.25rem 0.5rem;
    text-align: left;
  }

  .status-table th {
    background: #333;
  }

  .status-table tr:nth-child(even) {
    background: #252525;
  }

  .status-table tr.no-data {
    color: #888;
  }

  .hours-ago {
    font-variant-numeric: tabular-nums;
  }

  .cell-highlight {
    color: #e6d700;
    font-weight: bold;
  }

  .log-warn {
    color: #dcdc00;
    font-weight: bold;
  }

  .log-err {
    color: #f14c4c;
    font-weight: bold;
  }

  .log-msg {
    max-width: 28rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pref-link {
    color: #6fb3d8;
    text-decoration: none;
  }

  .pref-link:hover {
    text-decoration: underline;
  }

  .log-details {
    margin-top: 1rem;
  }

  .log-meta {
    margin: 0.5rem 0;
    font-size: 0.9rem;
    color: #858585;
  }

  .log-body {
    white-space: pre-wrap;
    word-break: break-all;
    font-family: monospace;
    margin: 0;
    background: #111;
    padding: 0.5rem;
    border-radius: 4px;
  }
</style>

