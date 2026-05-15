# Quality Review — `src/services/signals.js`

**Data:** 2026-04-26
**Branch:** `refactor/modular-indicators`
**Commit base:** `b0ee686` (após Tarefas 1 e 2)
**Escopo:** Review não-destrutivo dos 4 pontos solicitados.

---

## Sumário executivo

Os 4 pontos de revisão estão **corretos** na implementação atual. Nenhum bug crítico identificado. Apenas observações menores sobre robustez defensiva, nenhuma justifica modificação no código.

| # | Item | Status |
|---|------|--------|
| 1 | Confluência tf1/tf2 em `computeVipSignal` | ✅ correto |
| 2 | Cobertura de blockers em `buildSignalAudit` | ✅ comprehensiva |
| 3 | Invalidação de TTL do `_signalCache` | ✅ correta |
| 4 | Null handling de `computeSignals` em `alerts.js` | ✅ defensivo |

---

## 1. Confluência tf1/tf2 em `computeVipSignal`

**Arquivo:** `src/services/signals.js` linhas 354–873

### Implementação atual

```js
const data = await getAsset(assetKey);              // 1 fetch único
const entryCandles = data[entryKey] || [];          // ex: 15m
const biasCandles  = data[biasKey]  || [];          // ex: 1h

// FILTRO 1 — direção vem do TF maior
const direction = getBiasTf(biasCandles);
if (direction === 'NEUTRAL') return { ...status: 'NO_BIAS' };

// FILTRO 2 — EMAs do entry TF DEVEM alinhar com a direção do bias
const filterEma = emaAligned(closes, direction);

// FILTRO 3 — Breakout no entry TF na direção do bias
const filterBreakout = hasBreakout(entryCandles, direction, ...);

// FILTRO 4 — ADX no entry TF
const filterAdx = adx >= MASTER_SIGNAL_CFG.adxTrendMin;
```

### Avaliação

A confluência **é implícita e correta**: `direction` resulta do bias TF (1h por padrão) e todos os filtros subsequentes (EMA, breakout, divergência) recebem essa mesma `direction` como argumento. Assim, `filterEma=true` significa “EMAs do 15m alinhadas no MESMO sentido que o bias 1h”. Não há duplicação nem janela de inconsistência.

O bônus 4H (`bias4h`, linha 510) é um **filtro adicional de macro**, não um substituto da confluência primária — o que é o comportamento desejado e está bem comentado.

### Observação não-crítica

A separação `entryKey`/`biasKey` cai em fallback `'15m'`/`'1h'` quando `entryTf`/`biasTf` chegam com strings desconhecidas (linhas 358–360). Isso é silencioso. Não é um bug — `routes/vip.js` já valida `VALID_TFS` antes de chamar — mas se `computeVipSignal` for chamado de outro caller no futuro, valeria lançar erro em vez de silenciosamente cair em padrão.

---

## 2. Cobertura de blockers em `buildSignalAudit`

**Arquivo:** `src/services/signals.js` linhas 115–155

### Blockers verificados

```js
if (!signal.adxOk)                       blockers.push(`ADX baixo (${signal.adx.toFixed(1)})`);
if (!sessionInfo.isGood)                 blockers.push(`Fora da sessão ideal (${sessionInfo.sessionStr})`);
if (newsInfo.isNearNews)                 blockers.push(`Notícia próxima: ${newsInfo.nearName || 'alto impacto'}`);
if (signal.bkSig === 'AGUARDAR')         blockers.push('Sem breakout confirmado');
if (signal.rsiTrendSig === 'NEUTRO')     blockers.push(`RSI neutro (${signal.rsi.toFixed(1)})`);
if (signal.trendSig === 'NEUTRO')        blockers.push('EMAs sem alinhamento');
```

### Avaliação

Os 6 blockers cobrem as três categorias de rejeição que importam:
- **Estrutura técnica** (ADX, breakout, RSI trend, EMA trend) → 4 verificações
- **Contexto de mercado** (sessão, notícia) → 2 verificações

São exatamente os mesmos critérios usados pelo Master Score (linhas 294–304). Nada relevante está faltando.

### Observação não-crítica

`signal.adx.toFixed(1)` e `signal.rsi.toFixed(1)` (linhas 124 e 128) não checam null. Em prática `calcADX` e `calcRSI` sempre devolvem números (mesmo `NaN`), então `.toFixed()` não lança — mas se algum dia `calcADX` puder devolver `null`, isso quebra. Mitigação trivial seria `(signal.adx ?? 0).toFixed(1)`. Não é crítico.

---

## 3. Invalidação de TTL do `_signalCache`

**Arquivos:** `src/services/signals.js` linhas 70–75, `src/routes/vip.js` linhas 70–82, `src/scheduler.js` linha 125

### Implementação atual

Definição (`signals.js` 74–75):
```js
const SIGNAL_CACHE_TTL_MS = 7 * 60 * 1000;   // 7 min
const _signalCache        = {};               // { [key]: { data, cachedAt } }
```

Leitura (`routes/vip.js` 70–75):
```js
const cached = _signalCache[cacheKey];
const forceRefresh = req.query.force === '1';

if (!forceRefresh && cached && (Date.now() - cached.cachedAt) < SIGNAL_CACHE_TTL) {
  return res.json({ ...cached.data, _cached: true, _cachedAt: cached.cachedAt });
}
```

Escrita (`routes/vip.js` 82, `routes/vip.js` 214, `scheduler.js` 125):
```js
_signalCache[cacheKey] = { data: signal, cachedAt: Date.now() };
```

### Avaliação

A invalidação é **lazy e correta**:
- TTL é checada no momento da leitura (`Date.now() - cached.cachedAt < SIGNAL_CACHE_TTL`).
- Não há mecanismo de purga em background — o que é apropriado dado o tamanho fixo (≈ 4 ativos × 3 combinações TF = ~12 entries máx).
- TTL de 7 min cobre folgadamente o ciclo do scheduler (2 ou 5 min dependendo de OANDA), portanto a UI nunca pega cache vazio entre ciclos.
- `force=1` permite bypass quando o cliente precisa de dado fresco.

Sem vazamento de memória, sem janela de inconsistência. Nada a ajustar.

### Observação não-crítica

Não existe sincronização explícita entre o write do scheduler (linha 125 de `scheduler.js`) e o read da rota — mas como Node.js é single-threaded e a operação é uma atribuição atômica de objeto, não há race possível.

---

## 4. Null handling de `computeSignals` em `alerts.js`

**Arquivo:** `src/services/alerts.js` — duas chamadas

### `checkAndSendAlerts` (linhas 103–124)

```js
if (!candles15m || candles15m.length < 50) return;        // guard antes
const s = computeSignals(candles15m, ...);                // sempre objeto
if (s.score !== 0) {
  if (candles1h && candles1h.length >= 20) {
    const s1h = computeSignals(candles1h, ...);            // sempre objeto
    if (Math.sign(s1h.score) === dir) s.tfConfluence.push('1H');
  }
  ...
}
```

`computeSignals` (linha 330 de signals.js) **sempre retorna o objeto signal completo** — nunca `null`/`undefined`. Os campos críticos (`score`, `tfConfluence`) também são sempre populados (linhas 301, 334). Portanto não há acesso null-unsafe possível neste caminho.

### `attachSignals` (linhas 262–287)

```js
if (data.isSimulation || data.isMarketClosed || !data['15m']?.length) return data;
try {
  const s15   = computeSignals(data['15m'], ...);
  const s1h   = data['1h']?.length    >= 20 ? computeSignals(...) : null;
  const s4h   = data['4h']?.length    >= 10 ? computeSignals(...) : null;
  const sDaily= data['daily']?.length >= 10 ? computeSignals(...) : null;

  const dir = Math.sign(s15.score);
  if (s1h && Math.sign(s1h.score) === dir && dir !== 0) confluence.push('1H');
  if (s4h && Math.sign(s4h.score) === dir && dir !== 0) confluence.push('4H');
  ...
} catch (e) {
  logger.warn(`attachSignals ${key}:`, e.message);
}
```

- `s15` sempre objeto.
- `s1h`, `s4h`, `sDaily` podem ser `null` quando o array de candles é curto — mas todo uso subsequente é guarded com `if (sXh && ...)`.
- O try/catch externo absorve qualquer erro inesperado (por exemplo se `data['15m']` tiver < 50 candles e `calcEMA` quebrar internamente) — preferindo log + payload sem `data.signals` a um 500 na rota.

### Observação não-crítica

`attachSignals` aceita `data['15m']` com qualquer tamanho > 0, enquanto `checkAndSendAlerts` exige `>= 50`. Em prática nunca temos < 50 candles em produção (todos os data sources devolvem 100+ amostras), então isto nunca dispara — mas seria mais limpo padronizar o threshold mínimo no início de `attachSignals` para evitar custos de cálculo descartados pelo try/catch. Não é crítico.

---

## Recomendações (opcionais, não-bloqueantes)

Caso haja apetite para hardening adicional futuro, em ordem de prioridade:

1. **Guard de threshold mínimo em `attachSignals`** — adicionar `if (data['15m'].length < 50) return data;` antes do try evita calcular EMAs sobre amostras curtas.
2. **Null-safe `.toFixed(1)` em `buildSignalAudit`** — usar `(signal.adx ?? 0).toFixed(1)` e `(signal.rsi ?? 0).toFixed(1)` por segurança.
3. **Validação de `entryTf`/`biasTf` em `computeVipSignal`** — lançar erro em vez de fallback silencioso para `'15m'`/`'1h'` em entradas desconhecidas.

Nenhum dos três é necessário para correção do sistema atual. São apenas reduções de superfície de bug.

---

## Conclusão

O `signals.js` está **sólido e correto** nos 4 pontos auditados. Nenhuma modificação foi feita ao código durante esta revisão (escopo estritamente não-destrutivo). Os pontos menores listados acima podem ser endereçados em uma futura iteração de hardening, mas não há nada que justifique uma correção urgente.
