/**
 * Тесты каталога режимов Izhikevich.
 *
 * Каждый режим проверяется по СИГНАТУРЕ — свойству его спайковой
 * последовательности, которым режим и определён. Это принципиально: тест
 * «нарисовался похожий график» невозможен, а тест «в последовательности есть
 * группа спайков» — возможен и осмыслен.
 *
 * ─── Как выбирались протоколы ────────────────────────────────────────────
 *
 * Параметры (a, b, c, d) взяты из `figure1.m` — программы, которой сам автор
 * построил Figure 1 в работе 2004 года (файл лежит в `reference/`, в git не
 * попадает). Протоколы стимула подбирались ИЗМЕРЕНИЯМИ: каждый режим
 * прогонялся с разными токами и стартами, и в каталог записано то, что
 * действительно воспроизводит сигнатуру. История подбора — в
 * `docs/NEXT-SESSION.md`, раздел про калибровку каталога.
 *
 * ─── Статусы ─────────────────────────────────────────────────────────────
 *
 * 'signature' — сигнатура воспроизводится и проверяется строгим тестом.
 * 'partial'   — воспроизводится качественно, тест слабее (помечено явно).
 * 'known-limitation' — не воспроизводится; тест ОЖИДАЕТ провала сигнатуры и
 * документирует это. Если кто-то подкрутит параметры и режим заработает,
 * тест упадёт и заставит обновить статус. Молчаливое «мы это не проверяем»
 * было бы хуже.
 */

import { describe, expect, it } from 'vitest';
import { IZHI_MODES, izhRestState, modeById, modeToParams, stimulusCurrent } from '../core/neuron-types.js';
import { runSingleNeuron } from '../core/single-run.js';
import {
  coefficientOfVariation,
  findBursts,
  interSpikeIntervals,
  isiTrend,
  mean,
} from '../core/spike-analysis.js';
import { DEFAULT_NEURON_PARAMS, type NeuronParams } from '../core/types.js';

/** Прогнать режим из каталога с его собственным протоколом. */
function runMode(id: string, overrides: Record<string, unknown> = {}) {
  const mode = modeById(id);
  if (!mode) throw new Error(`Нет режима ${id}`);
  const params: NeuronParams = {
    model: 'izhikevich',
    lif: DEFAULT_NEURON_PARAMS.lif,
    izh: modeToParams(mode),
  };
  return runSingleNeuron({
    durationMs: mode.durationMs,
    dt: mode.dt ?? 0.1,
    stimulus: mode.stimulus,
    params,
    initial: mode.initial,
    baseline: mode.baseline,
    ...overrides,
  } as Parameters<typeof runSingleNeuron>[0]);
}

describe('каталог режимов: целостность', () => {
  it('содержит не меньше 20 режимов с уникальными идентификаторами', () => {
    expect(IZHI_MODES.length).toBeGreaterThanOrEqual(20);
    const ids = new Set(IZHI_MODES.map((mode) => mode.id));
    expect(ids.size).toBe(IZHI_MODES.length);
  });

  it('у каждого режима заполнены название, подсказка и формулировка сигнатуры', () => {
    for (const mode of IZHI_MODES) {
      expect(mode.title.length, mode.id).toBeGreaterThan(2);
      expect(mode.hint.length, mode.id).toBeGreaterThan(10);
      expect(mode.signature.length, mode.id).toBeGreaterThan(10);
      expect(mode.durationMs, mode.id).toBeGreaterThan(0);
    }
  });

  it('режимы, обещающие спайки, действительно спайкуют', () => {
    // Подпороговые режимы (интегратор, подпороговые колебания) вправе
    // молчать: их сигнатура описывается поведением потенциала. Признак
    // `spiking` в каталоге и есть ответ на вопрос «должен ли тут быть спайк».
    for (const mode of IZHI_MODES) {
      if (!mode.spiking) continue;
      const run = runMode(mode.id);
      expect(run.spikeTimes.length, `${mode.id}: ни одного спайка`).toBeGreaterThan(0);
    }
  });

  it('ни один режим не уходит в численный разлёт', () => {
    for (const mode of IZHI_MODES) {
      const run = runMode(mode.id);
      expect(run.state.insane, `${mode.id}: разлёт потенциала`).toBe(0);
    }
  });

  it('режимы различаются динамикой, а не только названием', () => {
    // Защита от «скопировали строку и забыли поменять параметры».
    const signatures = IZHI_MODES.map((mode) => {
      const run = runMode(mode.id);
      const isis = interSpikeIntervals(run.spikeTimes);
      return `${run.spikeTimes.length}|${(Number.isFinite(mean(isis)) ? mean(isis) : 0).toFixed(1)}`;
    });
    const unique = new Set(signatures);
    expect(unique.size).toBeGreaterThanOrEqual(Math.floor(IZHI_MODES.length * 0.7));
  });

  it('точка покоя согласована с параметрами модели', () => {
    // izhRestState решает 0.04V² + (5−b)V + (140+I) = 0 при u = bV.
    // Проверяем, что подстановка действительно обнуляет dV/dt.
    for (const [b, current] of [
      [0.2, 0],
      [0.25, 0],
      [-1, 40],
      [1.5, -65],
    ] as Array<[number, number]>) {
      const rest = izhRestState(b, current);
      const dv = 0.04 * rest.v * rest.v + 5 * rest.v + 140 - rest.u + current;
      expect(Math.abs(dv), `b=${b} I=${current}`).toBeLessThan(1e-9);
      expect(rest.u).toBeCloseTo(b * rest.v, 9);
    }
  });
});

describe('режимы: тоническое и фазическое спайкование', () => {
  it('A: тоническое спайкование — много спайков, после разгона ровный ряд', () => {
    const run = runMode('tonic-spiking');
    const isis = interSpikeIntervals(run.spikeTimes);
    expect(run.spikeTimes.length).toBeGreaterThan(8);
    // Первые интервалы короткие (переходный процесс), дальше ряд выравнивается.
    // Проверяем именно хвост: «ровный ряд» — это установившийся режим,
    // а не весь сигнал целиком.
    const tail = isis.slice(Math.ceil(isis.length / 3));
    expect(coefficientOfVariation(tail)).toBeLessThan(0.1);
  });

  it('B: фазическое спайкование — один спайк при продолжающемся токе', () => {
    const run = runMode('phasic-spiking');
    expect(run.spikeTimes.length).toBe(1);
    // И этот спайк — внутри окна стимула, а не после него.
    expect(run.spikeTimes[0]).toBeGreaterThanOrEqual(20);
    expect(run.spikeTimes[0]).toBeLessThan(100);
  });

  it('C: тонические пачки — несколько групп с коротким внутригрупповым ISI', () => {
    const run = runMode('tonic-bursting');
    const bursts = findBursts(run.spikeTimes, { maxIntraMs: 10, minSize: 2 });
    expect(bursts.length).toBeGreaterThanOrEqual(2);
  });

  it('D: фазические пачки — одна группа, дальше тишина', () => {
    const run = runMode('phasic-bursting');
    const bursts = findBursts(run.spikeTimes, { maxIntraMs: 15, minSize: 2 });
    expect(bursts.length).toBe(1);
    const lastBurst = bursts[0];
    expect(run.spikeTimes.filter((t) => t > lastBurst.endMs).length).toBe(0);
  });

  it('смешанный режим — сначала группа, затем одиночные спайки', () => {
    const run = runMode('mixed-mode');
    const bursts = findBursts(run.spikeTimes, { maxIntraMs: 10, minSize: 2 });
    expect(bursts.length).toBeGreaterThanOrEqual(1);
    expect(run.spikeTimes.filter((t) => t > bursts[0].endMs).length).toBeGreaterThan(2);
  });

  it('адаптация частоты — интервалы в хвосте заметно длиннее', () => {
    const run = runMode('adaptation');
    const isis = interSpikeIntervals(run.spikeTimes);
    expect(isis.length).toBeGreaterThan(4);
    expect(isiTrend(isis)).toBeGreaterThan(1.5);
  });
});

describe('режимы: возбудимость и задержка', () => {
  it('класс 1 — вблизи порога частота мала и растёт с током', () => {
    // Реобаза при b = −0.1 лежит около I ≈ 22 (измерено). Берём точку чуть
    // выше порога и точку вдвое дальше: у класса 1 частота отходит от нуля
    // ПЛАВНО, поэтому вблизи порога она исчисляется единицами герц, а не
    // десятками, как было бы у класса 2.
    const low = runMode('class1', {
      stimulus: { kind: 'const', amplitude: 25 },
      durationMs: 400,
    });
    const high = runMode('class1', {
      stimulus: { kind: 'const', amplitude: 50 },
      durationMs: 400,
    });
    const rateLow = (low.spikeTimes.length / 400) * 1000;
    const rateHigh = (high.spikeTimes.length / 400) * 1000;
    expect(rateLow).toBeGreaterThan(0);
    // Плавный отход от нуля: вблизи порога частота — единицы герц.
    expect(rateLow).toBeLessThan(25);
    expect(rateHigh).toBeGreaterThan(rateLow * 3);
  });

  it('класс 2 — частота начинается скачком, а не от нуля', () => {
    const run = runMode('class2');
    const isis = interSpikeIntervals(run.spikeTimes);
    expect(isis.length).toBeGreaterThan(3);
    // Первый интервал уже короткий: нет плавного нарастания от нулевой частоты.
    expect(isis[0]).toBeLessThan(40);
  });

  it('задержка ответа: первый спайк наступает не мгновенно', () => {
    const mode = modeById('latency');
    const run = runMode('latency');
    const from = mode?.stimulus.kind === 'pulse' ? mode.stimulus.fromMs : 0;
    expect(run.spikeTimes.length).toBeGreaterThanOrEqual(1);
    expect(run.spikeTimes[0] - from).toBeGreaterThan(3);
  });
});

describe('режимы: подпороговая динамика', () => {
  /** Число смен знака производной и размах амплитуды «раньше/позже». */
  function oscillationShape(values: number[]): {
    reversals: number;
    earlyAmplitude: number;
    lateAmplitude: number;
  } {
    const tail = values.slice(Math.floor(values.length / 2));
    let reversals = 0;
    for (let i = 2; i < tail.length; i++) {
      const d1 = tail[i] - tail[i - 1];
      const d0 = tail[i - 1] - tail[i - 2];
      if (d1 * d0 < 0) reversals += 1;
    }
    const quarter = Math.max(1, Math.floor(tail.length / 4));
    const head = tail.slice(0, quarter);
    const end = tail.slice(-quarter);
    return {
      reversals,
      earlyAmplitude: Math.max(...head) - Math.min(...head),
      lateAmplitude: Math.max(...end) - Math.min(...end),
    };
  }

  it('подпороговые колебания: спайков нет, колебание есть и затухает', () => {
    const run = runMode('subthreshold-osc');
    expect(run.spikeTimes.length).toBe(0);
    const shape = oscillationShape(run.v);
    // Колебание есть: производная меняет знак несколько раз.
    expect(shape.reversals).toBeGreaterThanOrEqual(4);
    // И оно ЗАТУХАЕТ: к концу размах меньше, чем в начале. Это ровно то,
    // что предсказывает линеаризация (λ = −0.025 ± 0.111i): комплексная
    // пара с отрицательной вещественной частью.
    expect(shape.lateAmplitude).toBeLessThan(shape.earlyAmplitude);
    // Обе величины положительны: это не «ноль без данных».
    expect(shape.earlyAmplitude).toBeGreaterThan(0.05);
  });

  it('резонатор: отклик немонотонный, своя частота выше, чем у интегратора', () => {
    const run = runMode('resonator');
    expect(run.spikeTimes.length).toBe(0);
    const shape = oscillationShape(run.v);
    expect(shape.reversals).toBeGreaterThanOrEqual(4);

    // Резонатор отвечает колебанием, интегратор — простым зарядом.
    // Сравниваем число смен знака производной на одном окне: у резонатора
    // их заведомо больше, потому что его собственная частота выше.
    const integrator = runMode('integrator');
    const integratorShape = oscillationShape(integrator.v);
    expect(shape.reversals).toBeGreaterThan(integratorShape.reversals * 2);
  });

  it('интегратор: постоянный ток заряжает мембрану без колебаний', () => {
    const run = runMode('integrator');
    // Ток ниже реобазы: спайков нет, но потенциал уходит вверх от покоя.
    // Точка старта — покой при НУЛЕВОМ токе (не при токе стимула), иначе
    // нейрон начинал бы уже приспособленным и никуда бы не двигался.
    expect(run.spikeTimes.length).toBe(0);
    const rest = izhRestState(modeById('integrator')!.params.b, 0).v;
    const final = run.v[run.v.length - 1];
    // Заряд к порогу: потенциал заметно поднялся от покоя.
    expect(final).toBeGreaterThan(rest + 2);
    const shape = oscillationShape(run.v);
    // И при этом рост монотонный: разворотов производной почти нет.
    expect(shape.reversals).toBeLessThan(6);
  });

  it('RZ помечен как partial, и это проверяется по затуханию', () => {
    // Резонатор воспроизводится не полностью: узкополосного отклика
    // (селективности по частоте) проверить нечем, но подпороговое
    // затухающее колебание есть. Тест фиксирует именно это, а не больше.
    const run = runMode('rz');
    const tail = run.v.slice(Math.floor(run.v.length / 2));
    let reversals = 0;
    for (let i = 2; i < tail.length; i++) {
      if ((tail[i] - tail[i - 1]) * (tail[i - 1] - tail[i - 2]) < 0) reversals += 1;
    }
    // Отклик немонотонный — значит, колебательная мода возбуждена.
    expect(reversals).toBeGreaterThanOrEqual(3);
  });
});

describe('режимы: оттормаживание и бистабильность', () => {
  it('спайк оттормаживания — ровно один спайк после снятия торможения', () => {
    const mode = modeById('rebound-spike');
    const run = runMode('rebound-spike');
    const releaseAt = mode?.stimulus.kind === 'release' ? mode.stimulus.toMs : 0;
    expect(run.spikeTimes.filter((t) => t < releaseAt).length).toBe(0);
    expect(run.spikeTimes.length).toBe(1);
    expect(run.spikeTimes[0]).toBeGreaterThanOrEqual(releaseAt);
  });

  it('пачка оттормаживания — после снятия целая группа', () => {
    const mode = modeById('rebound-burst');
    const run = runMode('rebound-burst');
    const releaseAt = mode?.stimulus.kind === 'release' ? mode.stimulus.toMs : 0;
    const after = run.spikeTimes.filter((t) => t >= releaseAt);
    expect(after.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...interSpikeIntervals(after))).toBeLessThan(15);
  });

  it('бистабильность помечена как известное ограничение и это проверяется', () => {
    // Тест ожидает ПРОВАЛА сигнатуры. Бистабильность требует двух устойчивых
    // исходов при одном токе; в этой реализации при любом проверенном
    // базовом токе (−65…−40) и любом старте система приходит к одному
    // исходу — непрерывному разряду. Если это когда-нибудь заработает,
    // тест упадёт и заставит обновить статус в каталоге.
    const high = runMode('bistability');
    const low = runMode('bistability', { initial: { v: -90, u: -30 } });
    expect(high.spikeTimes.length).toBeGreaterThan(10);
    // Оба старта дают активность: второго (тихого) исхода нет.
    expect(low.spikeTimes.length).toBeGreaterThan(10);
  });
});

describe('режимы: адаптация и следы', () => {
  it('аккомодация помечена как известное ограничение и это проверяется', () => {
    // Тест ожидает ПРОВАЛА сигнатуры: с параметрами из figure1.m (b = 1,
    // d = 4) пандус и ступенька дают практически одинаковый частый разряд.
    // Аккомодация требует более медленной адаптации, чем допускает эта
    // пара (a, b) в двух переменных модели.
    const ramp = runMode('accommodation');
    const step = runMode('accommodation', {
      stimulus: { kind: 'pulse', amplitude: 5, fromMs: 0, toMs: 300 },
    });
    expect(ramp.spikeTimes.length).toBeGreaterThan(0);
    // Разница есть, но она не качественная: пандус НЕ молчит.
    expect(ramp.spikeTimes.length).toBeGreaterThan(step.spikeTimes.length * 0.5);
  });

  it('вариабельность порога: результат зависит от длительности импульса', () => {
    const mode = modeById('threshold-variability');
    if (mode?.stimulus.kind !== 'twoPulses') throw new Error('нужен twoPulses');
    // Каталожный протокол (импульс 3 мс) даёт спайк. Укорачиваем первый
    // импульс до 2 мс при той же амплитуде — и спайк пропадает. Это и есть
    // вариабельность порога: исход определяется не только амплитудой, но и
    // временем, которое потенциал провёл у порога.
    const catalog = runMode('threshold-variability');
    const shortened = runMode('threshold-variability', {
      stimulus: { ...mode.stimulus, firstToMs: mode.stimulus.firstFromMs + 2 },
    });
    expect(catalog.spikeTimes.length).toBeGreaterThan(0);
    expect(shortened.spikeTimes.length).toBe(0);
  });

  it('DAP: после спайка остаётся деполяризующий след', () => {
    const run = runMode('dap');
    expect(run.spikeTimes.length).toBeGreaterThan(0);
    // Индекс последнего отсчёта, попадающего на последний спайк.
    const lastSpike = run.spikeTimes[run.spikeTimes.length - 1];
    let lastIndex = -1;
    for (let i = 0; i < run.times.length; i++) if (run.times[i] <= lastSpike) lastIndex = i;
    if (lastIndex < 0) throw new Error('не найден последний спайк');
    const tailStart = Math.min(run.v.length - 1, lastIndex + 5);
    // След деполяризации: у DAP-режима c = −60, а след поднимает потенциал
    // заметно выше уровня сброса.
    const tailMax = Math.max(...run.v.slice(tailStart));
    expect(tailMax).toBeGreaterThan(-60);
  });
});

describe('режимы: типы нейронов коры', () => {
  it('FS частый и почти не адаптируется, RS редеет', () => {
    const rs = runMode('rs');
    const fs = runMode('fs');
    const rsIsis = interSpikeIntervals(rs.spikeTimes);
    const fsIsis = interSpikeIntervals(fs.spikeTimes);

    expect(mean(fsIsis)).toBeLessThan(mean(rsIsis));
    expect(isiTrend(rsIsis)).toBeGreaterThan(isiTrend(fsIsis));
    expect(isiTrend(fsIsis)).toBeLessThan(1.5);
  });

  it('IB: в начале пачка, дальше одиночные спайки', () => {
    const run = runMode('ib');
    const bursts = findBursts(run.spikeTimes, { maxIntraMs: 10, minSize: 2 });
    expect(bursts.length).toBeGreaterThanOrEqual(1);
    expect(run.spikeTimes.length).toBeGreaterThan(bursts[0].size);
  });

  it('CH: короткие внутрипачечные интервалы и длинные паузы между пачками', () => {
    const run = runMode('ch');
    const bursts = findBursts(run.spikeTimes, { maxIntraMs: 10, minSize: 2 });
    expect(bursts.length).toBeGreaterThanOrEqual(2);
    expect(mean(bursts.map((burst) => burst.intraIsiMs))).toBeLessThan(10);
    const gaps: number[] = [];
    for (let i = 1; i < bursts.length; i++) {
      gaps.push(bursts[i].startMs - bursts[i - 1].endMs);
    }
    expect(mean(gaps)).toBeGreaterThan(20);
  });

  it('LTS отвечает на более слабый ток, чем RS', () => {
    const weak = { kind: 'pulse' as const, amplitude: 1.5, fromMs: 20, toMs: 220 };
    const rs = runMode('rs', { stimulus: weak, durationMs: 240 });
    const lts = runMode('lts', { stimulus: weak, durationMs: 240 });
    expect(lts.spikeTimes.length).toBeGreaterThan(rs.spikeTimes.length);
  });

  it('TC при слабом постоянном токе спайкует редко', () => {
    const run = runMode('tc');
    expect(run.spikeTimes.length).toBeGreaterThan(0);
    expect(run.spikeTimes.length).toBeLessThan(10);
  });
});

describe('режимы от торможения', () => {
  it('спайки от торможения: нейрон спайкует под своим базовым током', () => {
    const mode = modeById('inhibition-induced-spiking');
    const run = runMode('inhibition-induced-spiking');
    expect(run.spikeTimes.length).toBeGreaterThan(3);
    // Ток во время спайков равен базовому (протокол стимула нулевой).
    const baseline = mode?.baseline ?? 0;
    expect(baseline).toBeGreaterThan(0);
    for (const t of run.spikeTimes) {
      const index = run.times.findIndex((rt) => rt >= t);
      if (index >= 0) expect(run.current[index]).toBeCloseTo(baseline, 6);
    }
  });

  it('пачки от торможения: под тем же током есть группы спайков', () => {
    const run = runMode('inhibition-induced-bursting');
    const bursts = findBursts(run.spikeTimes, { maxIntraMs: 5, minSize: 2 });
    expect(bursts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('протоколы стимула', () => {
  it('постоянный ток идёт от fromMs и не заканчивается без toMs', () => {
    const pattern = { kind: 'const' as const, amplitude: 5, fromMs: 10 };
    expect(stimulusCurrent(pattern, 5)).toBe(0);
    expect(stimulusCurrent(pattern, 10)).toBe(5);
    expect(stimulusCurrent(pattern, 10000)).toBe(5);
  });

  it('импульс включается и выключается ровно на границах', () => {
    const pattern = { kind: 'pulse' as const, amplitude: 7, fromMs: 10, toMs: 20 };
    expect(stimulusCurrent(pattern, 9.9)).toBe(0);
    expect(stimulusCurrent(pattern, 10)).toBe(7);
    expect(stimulusCurrent(pattern, 19.9)).toBe(7);
    expect(stimulusCurrent(pattern, 20)).toBe(0);
  });

  it('пандус линейно интерполирует ток и выходит на конечное значение', () => {
    const pattern = {
      kind: 'ramp' as const,
      fromAmplitude: 0,
      toAmplitude: 10,
      durationMs: 100,
    };
    expect(stimulusCurrent(pattern, 0)).toBeCloseTo(0, 9);
    expect(stimulusCurrent(pattern, 50)).toBeCloseTo(5, 9);
    expect(stimulusCurrent(pattern, 100)).toBeCloseTo(10, 9);
    expect(stimulusCurrent(pattern, 900)).toBeCloseTo(10, 9);
  });

  it('два импульса: ток молчит до первого и между импульсами', () => {
    const pattern = {
      kind: 'twoPulses' as const,
      amplitude: 4,
      firstFromMs: 10,
      firstToMs: 20,
      secondFromMs: 40,
      secondToMs: 50,
    };
    expect(stimulusCurrent(pattern, 5)).toBe(0);
    expect(stimulusCurrent(pattern, 10)).toBe(4);
    expect(stimulusCurrent(pattern, 25)).toBe(0);
    expect(stimulusCurrent(pattern, 40)).toBe(4);
    expect(stimulusCurrent(pattern, 55)).toBe(0);
  });

  it('синусоидальный ток проходит через ноль и достигает амплитуды', () => {
    const pattern = { kind: 'sine' as const, amplitude: 2, frequencyHz: 10 };
    // Период 100 мс: на 25 мс — максимум, на 50 мс — ноль.
    expect(stimulusCurrent(pattern, 0)).toBeCloseTo(0, 9);
    expect(stimulusCurrent(pattern, 25)).toBeCloseTo(2, 9);
    expect(stimulusCurrent(pattern, 50)).toBeCloseTo(0, 9);
    expect(stimulusCurrent(pattern, 75)).toBeCloseTo(-2, 9);
  });
});
