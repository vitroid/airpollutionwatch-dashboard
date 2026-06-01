<script lang="ts">
  import { onMount } from 'svelte';
  import type { LogStatusItem, PrefectureInfo } from './api';
  import { fetchLogOverview, fetchLogPrefectureHistory, fetchPrefectures } from './api';


  let loading = true;
  let error: string | null = null;
  let lastFetched: Date | null = null;
  let statusItems: LogStatusItem[] = [];
  let collectLog: string | null = null;
  type HourMark = 'o' | 'x' | '-';
  type HistoryRow = { date: string; hours: HourMark[] };
  let historyDialogOpen = false;
  let historyLoading = false;
  let historyError: string | null = null;
  let historyRows: HistoryRow[] = [];
  let historyTitle = '';

  /** collect.log から県 ID に関する直近行のメッセージ部分を抜き出す */
  function extractLastCollectLogMessage(collectLog: string | null, prefId: string): string | null {
    if (!collectLog) return null;
    const needles = [`Prefecture ${prefId}:`, `Collecting ${prefId} `, ` ${prefId}:`];
    for (const line of collectLog.split('\n').reverse()) {
      if (!needles.some((n) => line.includes(n))) continue;
      const m = line.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+ \w+ (.+)$/);
      return m ? m[1] : line.trim();
    }
    return null;
  }

  /**
   * /v1/log の status_items に無い県を /v1/prefectures から補完する。
   * 新規追加県は巡回されていても API 側の一覧に載らないことがある。
   */
  function mergeStatusItems(
    fromLog: LogStatusItem[],
    prefectures: PrefectureInfo[],
    collectLog: string | null
  ): LogStatusItem[] {
    const byId = new Map(fromLog.map((it) => [it.pref_id, it]));
    const sorted = [...prefectures].sort((a, b) => a.id.localeCompare(b.id));
    return sorted.map((p) => {
      const existing = byId.get(p.id);
      if (existing) return existing;
      const collectMsg = extractLastCollectLogMessage(collectLog, p.id);
      return {
        pref_id: p.id,
        name_ja: p.name_ja,
        region: p.region,
        latest_datetime: null,
        hours_ago: null,
        oldest_continuous_datetime: null,
        continuous_days_ago: null,
        has_data: p.has_data,
        log_status: collectMsg ? 'warning' : 'error',
        log_message:
          collectMsg ??
          '県別ステータス API に未登録（/v1/log の status_items に含まれていません）',
        pref_url: null,
      };
    });
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const [res, prefs] = await Promise.all([
        fetchLogOverview(),
        fetchPrefectures().catch(() => [] as PrefectureInfo[]),
      ]);
      collectLog = res.collect_log ?? null;
      const fromLog = res.status_items ?? [];
      const merged =
        prefs.length > 0 ? mergeStatusItems(fromLog, prefs, collectLog) : fromLog;
      statusItems = await enrichStatusFromHistory(merged);
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

  function resolvePrefUrl(item: LogStatusItem): string | null {
    return item.pref_url ?? null;
  }

  function parseHourMark(v: unknown): HourMark {
    if (v === true || v === 1 || v === '1' || v === 'o' || v === 'O' || v === 'ok' || v === 'OK' || v === 'true' || v === 'TRUE') {
      return 'o';
    }
    if (v === false || v === 0 || v === '0' || v === 'x' || v === 'X' || v === 'ng' || v === 'NG' || v === 'false' || v === 'FALSE') {
      return 'x';
    }
    return '-';
  }

  function normalize24Hours(source: unknown): HourMark[] {
    const out: HourMark[] = Array.from({ length: 24 }, () => '-');
    if (Array.isArray(source) && source.length > 0 && source[0] && typeof source[0] === 'object') {
      for (const cell of source as Array<Record<string, unknown>>) {
        const hourRaw = cell.hour;
        if (typeof hourRaw !== 'number' || hourRaw < 0 || hourRaw > 23) continue;
        const markByHasData = parseHourMark(cell.has_data);
        if (markByHasData !== '-') {
          out[hourRaw] = markByHasData;
          continue;
        }
        out[hourRaw] = parseHourMark(cell.status);
      }
      return out;
    }
    if (Array.isArray(source)) {
      for (let h = 0; h < Math.min(source.length, 24); h++) out[h] = parseHourMark(source[h]);
      return out;
    }
    if (source && typeof source === 'object') {
      const obj = source as Record<string, unknown>;
      for (let h = 0; h < 24; h++) {
        const key1 = String(h);
        const key2 = `h${String(h).padStart(2, '0')}`;
        const key3 = String(h).padStart(2, '0');
        const val = obj[key1] ?? obj[key2] ?? obj[key3];
        out[h] = parseHourMark(val);
      }
      return out;
    }
    return out;
  }

  function hoursAgoFromIso(iso: string | null): number | null {
    if (!iso) return null;
    const normalized = iso.includes('+') || iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + '+09:00';
    const ms = new Date(normalized).getTime();
    if (Number.isNaN(ms)) return null;
    return Math.round(((Date.now() - ms) / (60 * 60 * 1000)) * 10) / 10;
  }

  function daysAgoFromIso(iso: string | null): number | null {
    if (!iso) return null;
    const normalized = iso.includes('+') || iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + '+09:00';
    const ms = new Date(normalized).getTime();
    if (Number.isNaN(ms)) return null;
    return Math.round(((Date.now() - ms) / (24 * 60 * 60 * 1000)) * 10) / 10;
  }

  /** 履歴表から直近のキャッシュあり時刻（JST 正時 ISO） */
  function computeLatestFromHistoryRows(historyRows: HistoryRow[]): string | null {
    const pad = (n: number) => String(n).padStart(2, '0');
    for (const row of historyRows) {
      const date = row.date.slice(0, 10);
      for (let h = 23; h >= 0; h--) {
        if (row.hours[h] === 'o') return `${date}T${pad(h)}:00:00+09:00`;
      }
    }
    return null;
  }

  function needsHistoryEnrich(item: LogStatusItem): boolean {
    return item.latest_datetime == null || item.oldest_continuous_datetime == null;
  }

  /** /v1/log に載らない・未集計の県を履歴 API の summary / rows で補完 */
  async function enrichStatusFromHistory(items: LogStatusItem[]): Promise<LogStatusItem[]> {
    const targets = items.filter(needsHistoryEnrich);
    if (targets.length === 0) return items;

    const patches = new Map<string, LogStatusItem>();
    await Promise.all(
      targets.map(async (item) => {
        try {
          const res = await fetchLogPrefectureHistory(item.pref_id);
          const root = res as Record<string, unknown>;
          const summary = (root.summary ?? {}) as Record<string, unknown>;
          const historyRows = normalizeHistoryRows(res);
          const latest =
            (typeof summary.latest_datetime === 'string' ? summary.latest_datetime : null) ??
            computeLatestFromHistoryRows(historyRows);
          const oldest =
            (typeof summary.oldest_continuous_datetime === 'string'
              ? summary.oldest_continuous_datetime
              : null) ?? null;
          const okSlots = typeof summary.ok_slots === 'number' ? summary.ok_slots : 0;
          const totalSlots = typeof summary.total_slots === 'number' ? summary.total_slots : null;
          const ratio = typeof summary.coverage_ratio === 'number' ? summary.coverage_ratio : null;
          const hasCache = okSlots > 0 || latest != null;

          if (!latest && !oldest && !hasCache) return;

          const coveragePct = ratio != null ? `${(ratio * 100).toFixed(1)}%` : null;
          const cacheNote =
            okSlots > 0 && totalSlots != null
              ? `キャッシュ ${okSlots}/${totalSlots} スロット${coveragePct ? ` (${coveragePct})` : ''}`
              : null;

          patches.set(item.pref_id, {
            ...item,
            latest_datetime: item.latest_datetime ?? latest,
            hours_ago: item.hours_ago ?? hoursAgoFromIso(latest),
            oldest_continuous_datetime: item.oldest_continuous_datetime ?? oldest,
            continuous_days_ago: item.continuous_days_ago ?? daysAgoFromIso(oldest),
            has_data: item.has_data || hasCache,
            log_status:
              item.log_status === 'error' && hasCache
                ? 'warning'
                : hasCache && ratio != null && ratio < 0.02
                  ? 'warning'
                  : hasCache && item.log_status === 'error'
                    ? 'ok'
                    : item.log_status,
            log_message: cacheNote
              ? item.log_message
                ? `${item.log_message}（${cacheNote}）`
                : cacheNote
              : item.log_message,
          });
        } catch {
          /* 履歴取得失敗時は元の行のまま */
        }
      })
    );

    return items.map((it) => patches.get(it.pref_id) ?? it);
  }

  function normalizeHistoryRows(payload: unknown): HistoryRow[] {
    const rows: HistoryRow[] = [];
    const root = (payload ?? {}) as Record<string, unknown>;
    // days は日数(数値)のことがあるため、配列のときだけ候補にする
    const candidates = [
      root.history,
      Array.isArray(root.days) ? root.days : null,
      root.rows,
      payload,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        for (const item of candidate) {
          if (!item || typeof item !== 'object') continue;
          const obj = item as Record<string, unknown>;
          const date = String(obj.date ?? obj.day ?? obj.target_date ?? obj.datetime ?? '');
          if (!date) continue;
          const hours = normalize24Hours(obj.cells ?? obj.hours ?? obj.hourly ?? obj.values ?? obj.cache ?? obj.statuses);
          rows.push({ date, hours });
        }
        if (rows.length > 0) break;
      } else if (candidate && typeof candidate === 'object') {
        const obj = candidate as Record<string, unknown>;
        for (const [k, v] of Object.entries(obj)) {
          if (!/^\d{4}-\d{2}-\d{2}/.test(k)) continue;
          rows.push({ date: k, hours: normalize24Hours(v) });
        }
        if (rows.length > 0) break;
      }
    }
    return rows
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((r) => ({ date: r.date.slice(0, 10), hours: r.hours }));
  }

  async function openHistoryDialog(item: LogStatusItem) {
    historyDialogOpen = true;
    historyLoading = true;
    historyError = null;
    historyRows = [];
    historyTitle = `${item.name_ja} キャッシュ履歴`;
    try {
      const res = await fetchLogPrefectureHistory(item.pref_id);
      historyRows = normalizeHistoryRows(res);
      if (historyRows.length === 0) {
        historyError = '履歴データ形式を解釈できませんでした。';
      }
    } catch (e) {
      historyError = e instanceof Error ? e.message : String(e);
    } finally {
      historyLoading = false;
    }
  }

  function closeHistoryDialog() {
    historyDialogOpen = false;
  }

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) closeHistoryDialog();
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
                {#if resolvePrefUrl(it)}
                  <a
                    href={resolvePrefUrl(it)}
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
              <td class="hours-ago" class:cell-highlight={isContinuousShort(it.continuous_days_ago)}>
                <button type="button" class="duration-link" on:click={() => openHistoryDialog(it)}>
                  {formatDaysAgo(it.continuous_days_ago)}
                </button>
              </td>
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

  {#if historyDialogOpen}
    <div class="history-backdrop" on:click={handleBackdropClick} role="presentation">
      <div
        class="history-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={historyTitle}
      >
        <div class="history-header">
          <h3>{historyTitle}</h3>
          <button type="button" class="close-button" on:click={closeHistoryDialog}>閉じる</button>
        </div>
        {#if historyLoading}
          <p class="history-meta">読み込み中…</p>
        {:else if historyError}
          <p class="history-error">取得できませんでした: {historyError}</p>
        {:else}
          <div class="history-table-wrap">
            <table class="history-table" aria-label="24時間キャッシュ履歴">
              <thead>
                <tr>
                  <th>日付</th>
                  {#each Array.from({ length: 24 }, (_, h) => h) as h}
                    <th>{h}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each historyRows as row}
                  <tr>
                    <td>{row.date}</td>
                    {#each row.hours as mark}
                      <td class:mark-ng={mark === 'x'}>
                        {mark === 'o' ? '〇' : mark === 'x' ? '×' : '—'}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="history-meta">横24時間 / 縦は記録日数、〇: キャッシュあり、×: なし</p>
        {/if}
      </div>
    </div>
  {/if}
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

  .duration-link {
    all: unset;
    cursor: pointer;
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .duration-link:hover {
    color: #9cdcfe;
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

  .history-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    z-index: 2000;
  }

  .history-dialog {
    width: min(96vw, 1300px);
    max-height: 90vh;
    overflow: auto;
    background: #1f1f1f;
    border: 1px solid #444;
    border-radius: 10px;
    padding: 0.8rem;
  }

  .history-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    margin-bottom: 0.6rem;
  }

  .history-header h3 {
    margin: 0;
    font-size: 1rem;
  }

  .close-button {
    padding: 0.3rem 0.7rem;
    border: 1px solid #666;
    border-radius: 6px;
    background: #333;
    color: #f5f5f5;
    cursor: pointer;
  }

  .history-table-wrap {
    overflow: auto;
    border: 1px solid #444;
  }

  .history-table {
    border-collapse: collapse;
    font-size: 0.78rem;
    width: 100%;
  }

  .history-table th,
  .history-table td {
    border: 1px solid #444;
    padding: 0.2rem 0.35rem;
    text-align: center;
    white-space: nowrap;
  }

  .history-table th:first-child,
  .history-table td:first-child {
    text-align: left;
    position: sticky;
    left: 0;
    background: #262626;
    z-index: 1;
  }

  .history-table thead th {
    position: sticky;
    top: 0;
    background: #303030;
    z-index: 2;
  }

  .history-table thead th:first-child {
    z-index: 3;
  }

  .mark-ng {
    color: #f14c4c;
    font-weight: 700;
  }

  .history-meta {
    margin: 0.6rem 0 0 0;
    color: #a0a0a0;
    font-size: 0.82rem;
  }

  .history-error {
    margin: 0.6rem 0 0 0;
    color: #ffb3b3;
  }
</style>

