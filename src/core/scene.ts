/**
 * Сборка сцены из пресета.
 *
 * Отдельный модуль, потому что здесь сходятся три вещи: параметры сети,
 * топология и стартовый стимул. Держать это в одном месте нужно, чтобы
 * пресет, уровень кампании и витринный кадр собирались ОДНИМ И ТЕМ ЖЕ кодом:
 * иначе «кадр из README» и «уровень 5» могут разойтись, и никто не заметит.
 */

import { Network } from './network.js';
import { Rng } from './rng.js';
import {
  buildSynapses,
  gridTopology,
  layeredTopology,
  randomSparseTopology,
  ringTopology,
  type TopologyOptions,
} from './synapses.js';
import { presetToNetworkParams, type Preset, type PresetTopology } from './presets.js';
import { DEFAULT_STDP, type StdpParams } from './stdp.js';

/** Собранная сцена: сеть и её пресет. */
export interface Scene {
  preset: Preset;
  network: Network;
  /** Сколько миллисекунд сцена уже прогрета. */
  warmedMs: number;
}

/** Собрать сеть по пресету. */
export function buildScene(preset: Preset, overrides: { seed?: number } = {}): Scene {
  const params = presetToNetworkParams(preset);
  if (overrides.seed !== undefined) params.seed = overrides.seed;
  const network = new Network(params);

  const stdp: StdpParams = {
    ...DEFAULT_STDP,
    enabled: preset.stdp,
    // Границы берутся из ПРЕСЕТА, если заданы: значения по умолчанию
    // (0…1) — абсолютные и не годятся для сетей с весами на порядки больше.
    // См. комментарий к `stdpBounds` в `presets.ts` и дефект 44.
    ...(preset.stdpBounds ? { wMin: preset.stdpBounds.min, wMax: preset.stdpBounds.max } : {}),
  };
  // Собираем связями один раз: пересобирать топологию после создания
  // сети значило бы дважды считать матрицу связей.
  const matrix = buildTopology(preset, preset.topology, params.seed, params.inhibitoryFraction);
  network.setSynapses(matrix.matrix);
  // Координаты есть только у пространственных топологий: обе оси задаются
  // вместе, поэтому проверяем их парой, а не по отдельности.
  if (matrix.x && matrix.y) {
    network.x = matrix.x;
    network.y = matrix.y;
  }
  network.setStdp(stdp.enabled, stdp);

  return { preset, network, warmedMs: 0 };
}

/** Результат сборки топологии: матрица и, для решётки, координаты. */
function buildTopology(
  preset: Preset,
  topology: PresetTopology,
  seed: number,
  inhibitoryFraction: number,
): {
  matrix: ReturnType<typeof buildSynapses>;
  x?: Float64Array;
  y?: Float64Array;
} {
  const options: TopologyOptions = {
    count: preset.count,
    inhibitoryFraction,
    connectionProbability: topology.connectionProbability ?? 0.1,
    excitatoryWeight: topology.excitatoryWeight ?? 0.15,
    inhibitoryRatio: topology.inhibitoryRatio ?? 5,
    delay: preset.delay,
    delayJitter: preset.delayJitter,
    dt: preset.dt,
    rng: new Rng(seed),
  };

  switch (topology.kind) {
    case 'none':
      return { matrix: buildSynapses(preset.count, [], [], [], []) };
    case 'random-sparse':
      return { matrix: randomSparseTopology(options) };
    case 'ring':
      return { matrix: ringTopology({ ...options, span: topology.span ?? 3 }) };
    case 'layers':
      return {
        matrix: layeredTopology({
          ...options,
          layers: topology.layers ?? [Math.floor(preset.count / 3), preset.count],
          recurrentHidden: topology.recurrentHidden ?? false,
        }),
      };
    case 'grid': {
      const side = topology.side ?? Math.round(Math.sqrt(preset.count));
      const grid = gridTopology({
        ...options,
        count: side * side,
        side,
        radius: topology.radius ?? 8,
        speed: topology.speed ?? 4,
      });
      return { matrix: grid.matrix, x: grid.x, y: grid.y };
    }
  }
}

/**
 * Запустить стартовый стимул сцены.
 *
 * Пространственные пресеты без толчка просто молчат, поэтому стимул —
 * часть описания сцены, а не то, что пользователь обязан помнить.
 */
export function applyStarter(scene: Scene): void {
  const starter = scene.preset.starter;
  if (!starter) return;
  const { network, preset } = scene;

  if (starter.kind === 'spot') {
    // Центр решётки: для 'grid' координаты лежат в клетках.
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < preset.count; i++) {
      if (network.x[i] > maxX) maxX = network.x[i];
      if (network.y[i] > maxY) maxY = network.y[i];
    }
    network.setSpot({
      x: maxX / 2,
      y: maxY / 2,
      radius: starter.radius ?? 3,
      amplitude: starter.amplitude,
      untilMs: starter.durationMs,
    });
    return;
  }

  // Инъекция: первым `fraction` нейронам (в слоистой сцене это входная
  // группа, потому что она идёт первой).
  const count = Math.max(1, Math.round(preset.count * (starter.fraction ?? 0.2)));
  for (let i = 0; i < count; i++) {
    network.inject(i, starter.amplitude, starter.durationMs);
  }
}

/** Прогреть сцену: применить стимул и прокрутить `warmupMs` модельного времени. */
export function warmUp(scene: Scene): void {
  const { network, preset } = scene;
  applyStarter(scene);
  const steps = Math.max(0, Math.round(preset.warmupMs / preset.dt));
  if (steps > 0) network.run(steps);
  scene.warmedMs = network.state.time;
}
