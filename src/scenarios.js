function merge(base, patch) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object'
      ? merge(result[key], value) : structuredClone(value);
  }
  return result;
}
export function resolveScenario(base, scenario) {
  if (!scenario.id || !scenario.title || !['DESTROY','ESCAPE'].includes(scenario.objective?.type)) throw new Error('シナリオのID・名称・任務目標を確認してください');
  const config = merge(base, scenario.overrides || {});
  if (scenario.objective.type === 'ESCAPE') {
    const zone = scenario.objective.zone;
    if (!zone || ![zone.x, zone.y, zone.radius].every(Number.isFinite) || zone.radius <= 0 || Math.hypot(zone.x, zone.y) + zone.radius > config.worldRadius) throw new Error('離脱区域は作戦海域内に設定してください');
  }
  config.mission = structuredClone({ id: scenario.id, title: scenario.title, briefing: scenario.briefing, objective: scenario.objective, playerShip: scenario.playerShip, enemyShip: scenario.enemyShip, rules: scenario.rules || {}, policy: scenario.policy || {} });
  return config;
}

export async function loadScenarios(base, fetcher = fetch) {
  const load = async path => { const r = await fetcher(path); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return r.json(); };
  const catalog = await load('scenarios/index.json');
  if (!Array.isArray(catalog.scenarios) || !catalog.scenarios.length) throw new Error('シナリオが登録されていません');
  const seen = new Set();
  return Promise.all(catalog.scenarios.map(async entry => {
    if (seen.has(entry.id) || !/^[a-z0-9_-]+\.json$/.test(entry.file)) throw new Error('シナリオ一覧のID・ファイル名を確認してください');
    seen.add(entry.id);
    const data = await load(`scenarios/${entry.file}`);
    if (data.id !== entry.id) throw new Error('シナリオのIDが一覧と一致しません');
    return { ...data, config: resolveScenario(base, data) };
  }));
}
