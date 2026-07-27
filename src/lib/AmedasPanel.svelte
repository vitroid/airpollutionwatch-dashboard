<script lang="ts">
  import type { LatestRow, BBox } from './types';
  import MapPanelLeaflet from './MapPanelLeaflet.svelte';

  export let latestWithNames: LatestRow[] = [];
  export let neighborRows: LatestRow[] = [];
  export let bboxForMap: BBox = { minLon: 128, minLat: 30, maxLon: 146, maxLat: 46 };
  export let datetime: string | null = null;
  export let prefName: string = '';
  export let loading = false;
  export let error: string | null = null;
</script>

{#if error}
  <section class="section amedas-status">
    <h2>{prefName} AMeDAS（収束線検算）</h2>
    <p class="amedas-error" role="alert">AMeDAS 取得エラー: {error}</p>
  </section>
{:else if loading && latestWithNames.length === 0 && neighborRows.length === 0}
  <section class="section amedas-status">
    <h2>{prefName} AMeDAS（収束線検算）</h2>
    <p class="amedas-loading">気象庁 AMeDAS を取得中…</p>
  </section>
{:else}
  <MapPanelLeaflet
    {latestWithNames}
    {neighborRows}
    {bboxForMap}
    {datetime}
    {prefName}
    title={`${prefName} AMeDAS（収束線検算）`}
    markerMode="temp"
  />
{/if}

<style>
  .section {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: #fff;
    border-radius: 12px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 0;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  }
  .section h2 {
    margin: 0 0 0.75rem 0;
    font-size: 1.1rem;
    font-weight: 600;
    color: #333;
  }
  .amedas-error {
    margin: 0;
    color: #c62828;
    font-size: 0.95rem;
  }
  .amedas-loading {
    margin: 0;
    color: #555;
    font-size: 0.95rem;
  }
</style>
