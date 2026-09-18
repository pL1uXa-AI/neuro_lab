/**
 * Приложение: склейка ядра, рендера и интерфейса.
 *
 * ─── Что здесь происходит ────────────────────────────────────────────────
 *
 * Цикл кадра устроен так:
 *
 *   1. измерить, сколько шагов симуляции укладывается в бюджет кадра;
 *   2. продвинуть сеть на это число шагов;
 *   3. обновить приборы (осциллограф, растровая диаграмма, графики);
 *   4. отрисовать сцену;
 *   5. раз в несколько кадров обновить сводку в боковой панели.
 *
 * Приборы обновляются реже сцены: осциллограф и диаграмма перерисовываются
 * на Canvas2D, и делать это 60 раз в секунду незачем — глаз всё равно не
 * различит. Сцена — наоборот, каждый кадр.
 *
 * ─── Автоподстройка шагов ────────────────────────────────────────────────
 *
 * Замер стоимости шага охватывает ТОЛЬКО вызовы симуляции. В phys-lab этот
 * дефект реально случался (дефект 19): в замер попадала дорогая статистика,
 * и число шагов съезжало к единице на здоровой системе. Здесь замер явно
 * обёрнут вокруг `network.run`, и обновление приборов в него не входит.
 */

import type { Application } from 'pixi.js';
import { Network } from '../core/network.js';
import { PRESETS, presetById, customPreset, DEFAULT_CUSTOM, CUSTOM_TOPOLOGIES, type Preset, type CustomNetworkOptions } from '../core/presets.js';
import { buildScene, warmUp, type Scene } from '../core/scene.js';
import {
  DEFAULT_EXPERIMENT,
  describeExperiment,
  runLearningExperiment,
  type LearningExperimentResult,
} from '../core/experiment.js';
import { LEVELS, levelById, type Level } from '../levels/levels.js';
import { LevelSession, type LevelReport } from '../levels/session.js';
import { SceneRenderer } from '../render/scene.js';
import { SceneInput } from '../input/scene-input.js';
import { drawOscilloscope, type Trace } from '../render/oscilloscope.js';
import { drawRaster } from '../render/raster.js';
import { drawPlot, PLOT_COLORS } from '../render/plots.js';
import { AppState, format } from './state.js';
import { button, canvas, checkbox, h, rangeControl, section, statRow, toggleControl, type RangeControl } from '../ui/dom.js';

/** Как часто проверять условия уровня, мс. */
const LEVEL_POLL_MS = 500;

/** Сколько миллисекунд модельного времени показывать на осциллографе. */
const OSCILLOSCOPE_WINDOW_MS = 300;

/**
 * Ширина окна для мгновенной частоты популяции, мс модельного времени.
 *
 * 200 мс — компромисс, выбранный по измерению: при 50 мс кривая дрожит от
 * отдельных спайков, при 1000 мс сглаживается настолько, что всплеск
 * активности длительностью 100 мс уже не виден. На 200 мс и переходные
 * процессы видны, и шум не забивает линию.
 */
const RATE_WINDOW_MS = 200;

/** Публичный API приложения — точка входа для смоук-тестов и витрины. */
export interface NeuroLabApi {
  state: AppState;
  getScene(): Scene;
  renderer: SceneRenderer;
  camera: SceneRenderer['camera'];
  getSession(): LevelSession | null;
  getReport(): LevelReport | null;
  actions: {
    applyPreset(id: string): boolean;
    startLevel(id: string): boolean;
    checkLevel(): LevelReport | null;
    exitToSandbox(): void;
    toggleRun(): void;
    stepOnce(): void;
    runSteps(count: number): void;
    setStdp(enabled: boolean): void;
    setModel(model: 'lif' | 'izhikevich'): boolean;
    setInput(mode: 'const' | 'poisson' | 'none', amplitude?: number): void;
    injectSpot(x: number, y: number, radius: number, amplitude: number, durationMs: number): void;
    /** «Удар током» в мировую точку; сила и радиус — по умолчанию из состояния. */
    poke(x: number, y: number, strength?: number, radius?: number): void;
    /** Снять «удар током». */
    endPoke(): void;
    resetScene(): void;
    /**
     * Прогнать опыт обучения и вернуть ИЗМЕРЕННЫЙ результат.
     *
     * `learn: false` — контроль: та же процедура с выключенным STDP. Он
     * нужен потому, что без него «отклик вырос» ничего не доказывает.
     */
    runExperiment(options?: { trials?: number; learn?: boolean }): LearningExperimentResult;
    /** Последний результат опыта (null, если он ещё не запускался). */
    getExperiment(): LearningExperimentResult | null;
    openHelp(): void;
    /**
     * Закрыть справку, если она открыта.
     *
     * Нужно автоматическим проверкам и витрине: при первом запуске справка
     * показывается сама и НАКРЫВАЕТ сцену. Из-за этого витринные кадры
     * получались пустыми — на них был диалог вместо сети. Отключать показ
     * для всех нельзя: живому пользователю справка нужна.
     */
    closeHelp(): void;
  };
  /** Диагностика для сквозных проверок. */
  probe(): {
    neuronCount: number;
    synapseCount: number;
    spikesTotal: number;
    stdpUpdates: number;
    renderDrawn: number;
    renderFlashes: number;
    /** Сколько отрезков импульсов нарисовано в последнем кадре. */
    renderPulses: number;
    /** Сколько событий передачи лежит в следе импульсов. */
    pulseEvents: number;
    /** Сколько передач записано всего за прогон. */
    pulsesRecorded: number;
    /** Действует ли сейчас «удар током». */
    spotActive: boolean;
    timeMs: number;
    synchrony: number;
    meanRate: number;
    activeFraction: number;
    cv: number;
    insane: number;
    running: boolean;
    stepsPerFrame: number;
  };
  canvases: {
    stage(): HTMLCanvasElement | null;
    raster(): HTMLCanvasElement | null;
    oscilloscope(): HTMLCanvasElement | null;
    /** График частоты популяции (для проверок). */
    rate(): HTMLCanvasElement | null;
  };
  /** Текущее положение кисти в мировых координатах (для проверок). */
  inputBrush(): { x: number; y: number; radius: number } | null;
}

export class App {
  readonly state = new AppState();
  private readonly app: Application;
  private readonly host: HTMLElement;
  private renderer!: SceneRenderer;
  private scene!: Scene;
  private session: LevelSession | null = null;
  /** Последний отчёт по уровню: читается сквозной проверкой. */
  private lastReport: LevelReport | null = null;

  private stageHost!: HTMLElement;
  private sidebar!: HTMLElement;
  private hudTitle!: HTMLElement;
  private hudHint!: HTMLElement;
  private hudProgress!: HTMLElement;
  private rasterCanvas: HTMLCanvasElement | null = null;
  private oscilloscopeCanvas: HTMLCanvasElement | null = null;
  /** График частоты популяции: собирается из `trajectory`. */
  private rateCanvas: HTMLCanvasElement | null = null;
  private statHost: HTMLElement | null = null;
  private levelHost: HTMLElement | null = null;
  private reportHost: HTMLElement | null = null;
  private theoryHost: HTMLElement | null = null;
  private trajectory: Array<{ time: number; rate: number }> = [];
  private completedLevels = new Set<string>();
  /** Управление сценой мышью (удар током, панорама, масштаб). */
  private input: SceneInput | null = null;
  /** Действует ли сейчас удар током (чтобы не снимать его дважды). */
  private stimulusActive = false;
  /** Последний результат опыта обучения: показывается в панели «Опыт». */
  private experiment: LearningExperimentResult | null = null;
  /** Результат контрольного прогона (STDP выключен) — для сравнения. */
  private experimentControl: LearningExperimentResult | null = null;
  /** Куда выводить результат опыта. */
  private experimentHost: HTMLElement | null = null;
  /** Ползунки «своей сети»: нужны, чтобы вернуть их к значениям пресета. */
  private customControls: Array<{ set(value: number): void }> | null = null;
  /** Пояснение к выбранной структуре. */
  private customHint: HTMLElement | null = null;
  /** Ползунки сети: нужны, чтобы возвращать их к значениям пресета. */
  private networkControls: {
    weight: RangeControl;
    inhibition: RangeControl;
    input: RangeControl;
  } | null = null;

  /** Последняя измеренная стоимость одного шага симуляции, мс. */
  private stepCostMs = 0;
  private lastFrameAt = performance.now();
  private frameAccumulator = 0;
  private instrumentAccumulator = 0;
  private lastLevelPoll = 0;
  private currentStepsPerFrame = 1;

  constructor(host: HTMLElement, app: Application) {
    this.host = host;
    this.app = app;
  }

  /** Поднять интерфейс и загрузить начальную сцену. */
  async init(): Promise<void> {
    this.buildLayout();
    this.renderer = new SceneRenderer(this.app);
    // Настройки отрисовки берутся ИЗ СОСТОЯНИЯ, а не остаются умолчаниями
    // рендера. Иначе флажки в панели показывают одно, а сцена рисует другое:
    // именно этот дефект был виден на первом скриншоте — «Связи» выключены,
    // а сеть нарисована паутиной, потому что у `SceneRenderer.options`
    // значение по умолчанию `showLinks: true` никто не переопределил.
    this.syncRendererOptions();
    this.stageHost.append(this.app.canvas);
    this.applyPreset(PRESETS[0]);

    // Управление сценой: удар током, панорама, масштаб. Привязывается к
    // stageHost, а не к канвасу: канвас пересоздаётся при смене размера, а
    // подсказка HUD лежит поверх него с `pointer-events: none` и события не
    // перехватывает.
    this.input = new SceneInput(this.stageHost, this.renderer, {
      onPoke: (x, y) => this.pokeAt(x, y),
      onPokeEnd: () => this.endPoke(),
      onToggleRun: () => this.toggleRun(),
      onStep: () => this.stepOnce(),
      onReset: () => this.resetScene(),
      onHelp: () => this.openHelp(),
    });
    this.syncBrushRadius();

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.app.ticker.add(() => this.frame());
  }

  /** Перенести настройки вида из состояния в рендер. */
  private syncRendererOptions(): void {
    this.renderer.options.colorMode = this.state.view.colorMode;
    this.renderer.options.showLinks = this.state.view.showLinks;
    this.renderer.options.showGrid = this.state.view.showGrid;
    this.renderer.options.neuronScale = this.state.view.neuronScale;
    this.renderer.options.showPulses = this.state.view.showPulses;
    this.renderer.invalidateLinks();
  }

  /**
   * «Удар током» в мировую точку.
   *
   * Амплитуда и радиус берутся из состояния, а не заданы здесь: их меняют
   * ползунки, и держать их в двух местах значило бы однажды разойтись.
   * Радиус передаётся в «шагах между нейронами» — `Network.poke` сам
   * переводит его в мировые единицы, потому что масштаб мира у пресетов
   * разный (см. `neuronSpacing`).
   */
  private pokeAt(x: number, y: number): void {
    const network = this.scene?.network;
    if (!network) return;
    network.poke(x, y, this.state.view.brushRadius, this.state.view.pokeStrength, 6);
    this.stimulusActive = true;
  }

  /**
   * Перенести радиус кисти из состояния в контроллер ввода.
   *
   * Состояние хранит радиус в «шагах между нейронами» (так его видит
   * пользователь), а контроллеру для отрисовки кольца нужны мировые
   * единицы. Пересчёт делается при смене сцены и при движении ползунка —
   * именно в эти моменты масштаб мира и меняется.
   */
  private syncBrushRadius(): void {
    if (!this.input || !this.scene) return;
    this.input.brushRadius = this.scene.network.pokeRadiusWorld(this.state.view.brushRadius);
  }

  /**
   * Вернуть ползунки сети к значениям текущей сцены.
   *
   * Нужно при смене пресета и при сбросе. Без этого ползунок показывал бы
   * «1.0×» после того, как сцена собрана с другими весами, — а это ровно тот
   * класс дефектов, когда интерфейс и данные расходятся молча.
   */
  private syncNetworkControls(): void {
    if (!this.networkControls || !this.scene) return;
    const network = this.scene.network;
    this.networkControls.weight.set(network.currentWeightScale);
    this.networkControls.inhibition.set(network.params.inhibitoryFraction);
    this.networkControls.input.set(
      network.params.input.mode === 'poisson'
        ? network.params.input.weight
        : network.params.input.amplitude,
    );
  }

  /** Снять удар: стимул живёт только пока кнопка нажата. */
  private endPoke(): void {
    if (!this.stimulusActive) return;
    this.scene?.network.setSpot(null);
    this.stimulusActive = false;
  }

  // ─── Опыт по обучению ──────────────────────────────────────────────────

  /**
   * Прогнать опыт обучения: сеть учится различать два паттерна.
   *
   * ─── Почему это отдельная операция, а не «просто прогон» ────────────────
   *
   * До неё проект показывал, что веса МЕНЯЮТСЯ (счётчик обновлений, разброс
   * весов), но нигде не отвечал, стала ли сеть вести себя иначе. Разница
   * принципиальная: измерено, что на пресете «Обучение STDP» веса после
   * 1 200 000 обновлений лежат в 0.038…0.234, тогда как функциональный
   * порог в этих сетях — около 6. Обучение шло, поведение не менялось.
   *
   * Здесь прогоняется классический протокол с учителем, и результат
   * измеряется ДО и ПОСЛЕ: отклик на обученный паттерн против отклика на
   * необученный. Один прогон — обучение, второй (с выключенным STDP) —
   * контроль, без которого «выросло» ничего не доказывает.
   */
  runExperiment(options: { trials?: number; learn?: boolean } = {}): LearningExperimentResult {
    const network = this.scene.network;
    const config = {
      ...DEFAULT_EXPERIMENT,
      ...(options.trials !== undefined ? { trials: options.trials } : {}),
    };
    // Останавливаем живой цикл на время опыта: иначе сеть продолжает
    // считать между шагами опыта, и «до/после» меряется на разном числе
    // шагов — сравнение перестаёт быть честным.
    const wasRunning = this.state.running;
    this.state.running = false;
    try {
      const result = runLearningExperiment(network, config, { learn: options.learn ?? true });
      if (options.learn === false) this.experimentControl = result;
      else this.experiment = result;
      this.updateInstruments();
      this.updateStats();
      return result;
    } finally {
      this.state.running = wasRunning;
    }
  }

  /** Последний результат опыта. */
  getExperiment(): LearningExperimentResult | null {
    return this.experiment;
  }

  /**
   * Пересобрать сцену и запустить полный опыт: обучение плюс контроль.
   *
   * Контроль идёт на СВЕЖЕЙ копии сцены: на уже обученной сети он измерял бы
   * не «что было бы без обучения», а «что осталось от обучения».
   */
  private runExperimentPair(trials: number): void {
    const preset = this.state.presetId ? presetById(this.state.presetId) : undefined;
    if (!preset) return;

    // ─── Почему опыт начинается со СВЕЖЕЙ сцены ──────────────────────────
    //
    // Если обучать ту сеть, что уже на экране, второе нажатие кнопки дало бы
    // ДРУГОЙ результат: «до» измерялось бы на сети, которую уже обучили
    // первым прогоном. Опыт перестал бы воспроизводиться, а «до/после»
    // потеряло бы смысл — «до» означало бы «после предыдущего запуска».
    //
    // Поэтому сцена пересобирается из пресета, и обучение всегда идёт с нуля.
    // Побочный эффект полезен: пользователь видит обученную сеть на экране.
    this.applyPreset(preset);

    // Контроль идёт на ОТДЕЛЬНОЙ свежей сцене: на той же самой он измерял бы
    // не «что было бы без обучения», а «что осталось после него».
    const controlScene = buildScene(preset);
    warmUp(controlScene);
    this.experimentControl = runLearningExperiment(
      controlScene.network,
      { ...DEFAULT_EXPERIMENT, trials },
      { learn: false },
    );

    // Обучение — на сцене приложения: именно её пользователь видит и трогает.
    this.experiment = this.runExperiment({ trials, learn: true });
    this.renderExperiment();
  }

  /** Показать результат опыта в панели. */
  private renderExperiment(): void {
    if (!this.experimentHost) return;
    const result = this.experiment;
    this.experimentHost.replaceChildren();
    if (!result) {
      this.experimentHost.append(
        h(
          'div',
          { class: 'hint' },
          'Нажмите «Прогнать опыт»: сеть обучится на паттерне A и проверится ' +
            'на паттерне B. Результат — измеренный, а не «на глаз».',
        ),
      );
      return;
    }

    const { learned, summary } = describeExperiment(result, this.experimentControl ?? undefined);
    const table = h('div', { class: 'experiment' });
    const row = (label: string, value: string, cls = ''): HTMLElement =>
      h(
        'div',
        { class: `experiment__row ${cls}` },
        h('span', { class: 'experiment__label' }, label),
        h('span', { class: 'experiment__value' }, value),
      );

    table.append(
      row('отклик на A до', String(result.beforeA)),
      row('отклик на A после', String(result.afterA), result.gain > 0 ? 'experiment__row--up' : ''),
      row('отклик на B после', String(result.afterB)),
      row('разделение A − B', String(result.separation), result.separation > 0 ? 'experiment__row--up' : ''),
      row('средний вес', `${result.weightBefore.toFixed(3)} → ${result.weightAfter.toFixed(3)}`),
      row('обновлений STDP', format.int(result.stdpUpdates)),
    );
    if (this.experimentControl) {
      table.append(
        row(
          'контроль (без обучения)',
          `разделение ${this.experimentControl.separation}`,
          this.experimentControl.separation <= 0 ? 'experiment__row--ok' : 'experiment__row--warn',
        ),
      );
    }

    this.experimentHost.append(
      h(
        'div',
        { class: `experiment__verdict ${learned ? 'experiment__verdict--yes' : 'experiment__verdict--no'}` },
        learned ? 'Сеть научилась различать паттерны' : 'Различение не возникло',
      ),
      table,
      h('div', { class: 'hint' }, summary),
      h(
        'div',
        { class: 'hint' },
        'A — паттерн, на который сеть учили (стимул, затем «учитель» заставляет ' +
          'выход сработать). B — такой же по размеру паттерн, которым не учили. ' +
          'Если обучение работает, отклик на A выше.',
      ),
    );
  }

  /** Публичный API для проверок. */
  api(): NeuroLabApi {
    return {
      state: this.state,
      getScene: () => this.scene,
      renderer: this.renderer,
      camera: this.renderer.camera,
      getSession: () => this.session,
      getReport: () => this.lastReport,
      actions: {
        applyPreset: (id: string) => {
          const preset = presetById(id);
          if (!preset) return false;
          this.applyPreset(preset);
          return true;
        },
        startLevel: (id: string) => {
          const level = levelById(id);
          if (!level) return false;
          this.startLevel(level);
          return true;
        },
        checkLevel: () => this.session?.checkNow() ?? null,
        exitToSandbox: () => this.exitToSandbox(),
        toggleRun: () => this.toggleRun(),
        stepOnce: () => this.stepOnce(),
        runSteps: (count: number) => this.runSteps(count),
        setStdp: (enabled: boolean) => {
          this.state.stdpEnabled = enabled;
          this.scene.network.setStdp(enabled);
        },
        setModel: (model) => this.setModel(model),
        setInput: (mode, amplitude) => this.setInput(mode, amplitude),
        injectSpot: (x, y, radius, amplitude, durationMs) =>
          this.scene.network.setSpot({ x, y, radius, amplitude, untilMs: durationMs }),
        /** «Удар током» в мировую точку — то же, что делает мышь. */
        poke: (x, y, strength, radius) => {
          this.scene.network.poke(
            x,
            y,
            radius ?? this.state.view.brushRadius,
            strength ?? this.state.view.pokeStrength,
            6,
          );
          this.stimulusActive = true;
        },
        endPoke: () => this.endPoke(),
        runExperiment: (options) => this.runExperiment(options ?? {}),
        getExperiment: () => this.experiment,
        resetScene: () => this.resetScene(),
        openHelp: () => this.openHelp(),
        closeHelp: () => this.closeHelp(),
      },
      probe: () => this.probe(),
      canvases: {
        stage: () => this.stageHost.querySelector('canvas'),
        raster: () => this.rasterCanvas,
        oscilloscope: () => this.oscilloscopeCanvas,
        rate: () => this.rateCanvas,
      },
      inputBrush: () => this.input?.brush ?? null,
    };
  }

  // ─── Разметка ──────────────────────────────────────────────────────────

  private buildLayout(): void {
    this.host.replaceChildren();

    const topbar = h('header', { class: 'topbar' });
    topbar.append(
      h('div', { class: 'topbar__title' }, 'Neuro Lab', h('small', {}, 'спайковые сети')),
    );
    topbar.append(
      button('Пауза', () => this.toggleRun(), { class: 'btn--primary', 'data-action': 'run' }),
      button('Шаг', () => this.stepOnce(), { 'data-action': 'step' }),
      button('Сброс', () => this.resetScene(), { 'data-action': 'reset' }),
    );
    topbar.append(h('div', { class: 'topbar__spacer' }));
    const speedLabel = h('span', { class: 'field__value', 'data-stat': 'скорость' }, '—');
    topbar.append(h('span', { class: 'hint' }, 'шагов/кадр:'), speedLabel);
    topbar.append(button('Справка', () => this.openHelp()));

    this.stageHost = h('main', { class: 'stage' });
    const hud = h('div', { class: 'hud' });
    this.hudTitle = h('div', { class: 'hud__title' }, '');
    this.hudHint = h('div', { class: 'hud__hint' }, '');
    this.hudProgress = h('div', { class: 'hud__progress' }, h('div', { style: 'width: 0%' }));
    hud.append(this.hudTitle, this.hudHint, this.hudProgress);
    this.stageHost.append(hud);

    this.sidebar = h('aside', { class: 'sidebar' });
    this.buildSidebar();

    const instruments = h('section', { class: 'instruments' });
    const oscilloscopeBox = h('div', { class: 'instrument' });
    this.oscilloscopeCanvas = canvas('oscilloscope');
    this.oscilloscopeCanvas.dataset['instrument'] = 'oscilloscope';
    oscilloscopeBox.append(this.oscilloscopeCanvas);
    const rasterBox = h('div', { class: 'instrument' });
    this.rasterCanvas = canvas('raster');
    this.rasterCanvas.dataset['instrument'] = 'raster';
    rasterBox.append(this.rasterCanvas);

    // ─── Третий прибор: график частоты популяции ─────────────────────────
    //
    // Почему он здесь. Приложение УЖЕ собирало данные для него: массив
    // `trajectory` пополнялся каждый кадр (до 600 точек) и не использовался
    // нигде — данные копились и выбрасывались. Заодно модуль `render/plots.ts`
    // (225 строк) не импортировался ни одним файлом, а README обещал
    // «графики непрерывных величин».
    //
    // График частоты полезен именно здесь: осциллограф показывает ОДИН
    // нейрон, растровая диаграмма — кто когда сработал, а частота
    // популяции отвечает на вопрос «что происходит со всей сетью в целом»:
    // при обучении она падает, при разгоне растёт, у кольца выходит на
    // постоянную.
    //
    // Раскраска графика совпадает с палитрой рельс (PLOT_COLORS), чтобы не
    // вводить третью цветовую схему.
    const rateBox = h('div', { class: 'instrument' });
    this.rateCanvas = canvas('rate-plot');
    this.rateCanvas.dataset['instrument'] = 'rate-plot';
    rateBox.append(this.rateCanvas);

    instruments.append(oscilloscopeBox, rasterBox, rateBox);

    this.host.append(topbar, this.stageHost, this.sidebar, instruments);
  }

  /** Боковая колонка: сцены, нейрон, вход, обучение, вид, сводка, кампания. */
  private buildSidebar(): void {
    this.sidebar.replaceChildren();

    const presetButtons = h('div', { class: 'btn-row', 'data-section': 'presets' });
    for (const preset of PRESETS) {
      presetButtons.append(
        button(preset.title, () => this.applyPreset(preset), {
          class: 'btn--preset',
          'data-preset': preset.id,
          title: preset.hint,
        }),
      );
    }
    this.sidebar.append(section('Сцены', presetButtons));

    const modelToggle = toggleControl<'lif' | 'izhikevich'>({
      label: 'Модель',
      value: 'lif',
      items: [
        { id: 'lif', label: 'LIF', title: 'Одна переменная, точное решение' },
        { id: 'izhikevich', label: 'Izhikevich', title: 'Две переменные, 20+ типов' },
      ],
      onChange: (model) => this.setModel(model),
    });
    this.sidebar.append(section('Нейрон', modelToggle.root));

    const inputToggle = toggleControl<'const' | 'poisson' | 'none'>({
      label: 'Внешний вход',
      value: 'const',
      items: [
        { id: 'const', label: 'Постоянный', title: 'Ровный ток: регулярный разряд' },
        { id: 'poisson', label: 'Пуассон', title: 'Случайные события: нерегулярный разряд' },
        { id: 'none', label: 'Нет', title: 'Только связи и стимулы' },
      ],
      onChange: (mode) => this.setInput(mode),
    });
    this.sidebar.append(section('Вход', inputToggle.root));

    const stdpHost = h('div', { 'data-section': 'stdp' });
    stdpHost.append(
      checkbox({
        label: 'Обучение STDP',
        checked: true,
        onChange: (checked) => {
          this.state.stdpEnabled = checked;
          this.scene.network.setStdp(checked);
        },
      }),
    );
    this.sidebar.append(section('Обучение', stdpHost));

    // ─── Опыт: проверяемый результат обучения ────────────────────────────
    //
    // ─── Почему это нужно отдельной панелью ──────────────────────────────
    //
    // Всё, что проект показывал про обучение, — это ЧТО веса изменились:
    // счётчик обновлений STDP и разброс весов. Ответа на вопрос «стала ли
    // сеть вести себя иначе» не было нигде, и это не мелочь: измерено, что
    // при границах STDP по умолчанию (0…1) веса гуляют в диапазоне
    // 0.038…0.234 после миллиона обновлений, тогда как отклик читающего
    // слоя в этих сетях начинается около веса 6. То есть обучение работало,
    // а поведение не менялось НИКОГДА.
    //
    // Кнопка запускает классический протокол с учителем и показывает
    // измеренный результат: отклик на обученный паттерн A против отклика на
    // необученный B, до и после. Рядом идёт контроль с выключенным STDP —
    // без него «отклик вырос» ничего не доказывает, потому что сеть могла
    // просто разогреться от повторяющегося стимула.
    const experimentHost = h('div', { 'data-section': 'experiment' });
    const experimentOutput = h('div', { class: 'experiment__out' });
    this.experimentHost = experimentOutput;
    experimentHost.append(
      h(
        'div',
        { class: 'hint' },
        'Сеть учится различать два паттерна, и результат измеряется: отклик на ' +
          'обученный паттерн против необученного. Опыт занимает несколько секунд ' +
          'и каждый раз начинается со свежей сцены, поэтому повторный прогон даёт ' +
          'тот же результат. «Сброс» вернёт сцену к исходному пресету.',
      ),
      h(
        'div',
        { class: 'btn-row' },
        button('Прогнать опыт', () => this.runExperimentPair(DEFAULT_EXPERIMENT.trials), {
          class: 'btn--primary',
          'data-action': 'run-experiment',
        }),
        button('Опыт ×2', () => this.runExperimentPair(DEFAULT_EXPERIMENT.trials * 2), {
          'data-action': 'run-experiment-long',
        }),
      ),
      experimentOutput,
    );
    this.sidebar.append(section('Опыт', experimentHost));
    this.renderExperiment();

    const viewToggle = toggleControl<'potential' | 'spike' | 'type' | 'rate'>({
      label: 'Раскраска',
      value: 'potential',
      items: [
        { id: 'potential', label: 'Потенциал', title: 'От покоя к возбуждению' },
        { id: 'spike', label: 'Спайки', title: 'Вспышки в момент разряда' },
        { id: 'type', label: 'Тип', title: 'Возбуждающие и тормозные' },
        { id: 'rate', label: 'Частота', title: 'Кто разряжается чаще' },
      ],
      onChange: (mode) => {
        this.state.view.colorMode = mode;
        this.renderer.options.colorMode = mode;
      },
    });
    const viewHost = h('div', { 'data-section': 'view' });
    viewHost.append(
      viewToggle.root,
      checkbox({
        label: 'Импульсы',
        checked: true,
        onChange: (checked) => {
          this.state.view.showPulses = checked;
          this.renderer.options.showPulses = checked;
        },
      }),
      checkbox({
        label: 'Связи',
        checked: false,
        onChange: (checked) => {
          this.state.view.showLinks = checked;
          this.renderer.options.showLinks = checked;
          if (checked) this.renderer.invalidateLinks();
        },
      }),
      checkbox({
        label: 'Сетка',
        checked: true,
        onChange: (checked) => {
          this.state.view.showGrid = checked;
          this.renderer.options.showGrid = checked;
        },
      }),
    );
    this.sidebar.append(section('Вид', viewHost));

    // ─── Удар током ──────────────────────────────────────────────────────
    //
    // Ползунки, а не константы: сила и радиус удара — то, что подбирают на
    // глаз под конкретную сцену. У одиночного нейрона порог 1.5 нА, у
    // волны рабочая амплитуда 40; один «правильный» размер для всего
    // проекта подобрать нельзя.
    const pokeHost = h('div', { 'data-section': 'poke' });
    const strengthControl = rangeControl({
      label: 'Сила удара',
      min: 2,
      max: 80,
      step: 1,
      value: this.state.view.pokeStrength,
      format: (value) => `${value}`,
      onInput: (value) => {
        this.state.view.pokeStrength = value;
      },
    });
    const radiusControl = rangeControl({
      label: 'Радиус',
      min: 1,
      max: 10,
      step: 0.5,
      value: this.state.view.brushRadius,
      format: (value) => value.toFixed(1),
      onInput: (value) => {
        this.state.view.brushRadius = value;
        this.syncBrushRadius();
      },
    });
    pokeHost.append(
      h(
        'div',
        { class: 'hint' },
        'Тяните мышью по сцене — удар током идёт за курсором. Shift или средняя кнопка — сдвиг, колесо — масштаб.',
      ),
      strengthControl.root,
      radiusControl.root,
    );
    this.sidebar.append(section('Стимул', pokeHost));

    // ─── Сеть: вес связей, торможение, амплитуда входа ───────────────────
    //
    // ─── Почему эти ползунки обязаны существовать ────────────────────────
    //
    // Уровень 8 («Своя сеть») требует: «начните с пресета и меняйте по
    // одному параметру», «если сеть молчит — поднимите вес связей»,
    // «если всё синхронно — добавьте торможение». Но НИ ОДНОГО из этих
    // ползунков в интерфейсе не было: уровень проходился сразу, не требуя
    // действий, а подсказки отправляли искать несуществующие ручки.
    //
    // Измерено: `level-08` давал `passed = true` без единого действия игрока
    // (800 из 800 нейронов, 11.2 Гц на пресете по умолчанию).
    //
    // Вес задан МНОЖИТЕЛЕМ, а не абсолютным числом: базовые веса у пресетов
    // различаются на порядки (200 у волны, 0.15 у разреженной сети), и один
    // абсолютный «вес» не подошёл бы никому.
    // ─── Почему здесь НЕТ чтения this.scene ─────────────────────────────
    //
    // Разметка строится в `init()` ДО первой сцены: `buildSidebar` вызывается
    // из `buildLayout`, а `applyPreset` — уже после. Первая версия читала
    // здесь `this.scene.network.params...` и падала с
    // «Cannot read properties of undefined» — приложение не поднималось
    // вообще.
    //
    // Поэтому значения берутся из умолчаний, а настоящие подставляет
    // `syncNetworkControls()` при сборке каждой сцены.
    const netHost = h('div', { 'data-section': 'network' });

    const weightControl = rangeControl({
      label: 'Вес связей',
      min: 0.2,
      max: 5,
      step: 0.1,
      value: 1,
      format: (value) => `${value.toFixed(1)}×`,
      onInput: (value) => {
        this.scene?.network.setWeightScale(value);
        this.renderer?.invalidateLinks();
      },
    });

    const inhibitionControl = rangeControl({
      label: 'Торможение',
      min: 0,
      max: 0.5,
      step: 0.05,
      value: 0.2,
      format: (value) => `${Math.round(value * 100)} %`,
      onInput: (value) => {
        this.scene?.network.setInhibitoryFraction(value);
        this.renderer?.invalidateLinks();
      },
    });

    const inputAmpControl = rangeControl({
      label: 'Вход',
      min: 0,
      max: 20,
      step: 0.5,
      value: 0,
      format: (value) => value.toFixed(1),
      onInput: (value) => {
        const network = this.scene?.network;
        if (!network) return;
        network.params.input.amplitude = value;
        network.params.input.weight = value;
      },
    });

    netHost.append(
      h(
        'div',
        { class: 'hint' },
        'Правки действуют сразу на текущую сцену. «Сброс» вернёт исходные значения пресета.',
      ),
      weightControl.root,
      inhibitionControl.root,
      inputAmpControl.root,
    );
    this.sidebar.append(section('Сеть', netHost));

    // ─── Своя сеть: сборка структуры, а не подкрутка чисел ───────────────
    //
    // ─── Почему отдельно от панели «Сеть» ────────────────────────────────
    //
    // Та панель правит УЖЕ СОБРАННУЮ сцену: вес, торможение, вход. Она не
    // позволяет выбрать структуру — сколько нейронов, как они соединены, с
    // какой плотностью. А вопрос «можно ли построить свою сеть» именно про
    // структуру: без неё «собрать сеть» сводилось к трём множителям.
    //
    // Здесь параметры задаются заранее и по кнопке собирают НОВУЮ сцену.
    // Это честнее, чем «на живу»: смена топологии требует перестройки
    // матрицы связей, и делать вид, что она происходит мгновенно, нельзя —
    // индексы CSR, задержки и координаты обязаны быть согласованы.
    //
    // Обещаний здесь нет намеренно: при произвольных числах явления может и
    // не быть. Панель показывает, ЧТО получилось, а не что «должно».
    this.sidebar.append(section('Своя сеть', ...this.buildCustomPanel()));
    // Запоминаем контролы: при смене сцены их надо вернуть к значениям
    // пресета, иначе подписи показывают одно, а сеть считает другое.
    this.networkControls = { weight: weightControl, inhibition: inhibitionControl, input: inputAmpControl };

    this.statHost = h('div', { 'data-section': 'stats' });
    this.statHost.append(
      statRow('время', '—'),
      statRow('спайков', '—'),
      statRow('частота', '—'),
      statRow('активных', '—'),
      statRow('CV ISI', '—'),
      statRow('синхронность', '—'),
      statRow('связей', '—'),
      statRow('обучений', '—'),
    );
    this.sidebar.append(section('Сводка', this.statHost));

    this.levelHost = h('div', { class: 'level-list', 'data-section': 'levels' });
    this.theoryHost = h('div', { class: 'theory', 'data-section': 'theory' });
    this.reportHost = h('div', { class: 'report', 'data-section': 'report' });
    const campaign = h('div', {});
    campaign.append(
      this.levelHost,
      h('div', { class: 'btn-row' }, button('В песочницу', () => this.exitToSandbox())),
      this.reportHost,
      this.theoryHost,
    );
    this.sidebar.append(section('Кампания', campaign));

    this.renderLevelList();
  }

  /** Перерисовать список уровней. */
  private renderLevelList(): void {
    if (!this.levelHost) return;
    this.levelHost.replaceChildren();
    for (const level of LEVELS) {
      const active = level.id === this.state.levelId;
      const done = this.completedLevels.has(level.id);
      const item = h(
        'div',
        {
          class: `level-item ${active ? 'level-item--on' : ''} ${done ? 'level-item--done' : ''}`,
          'data-level': level.id,
          on: { click: () => this.startLevel(level) },
        },
        h('span', { class: 'level-item__mark' }, done ? '✓' : '·'),
        h('span', { class: 'level-item__title' }, level.title),
      );
      this.levelHost.append(item);
    }
  }

  // ─── Управление сценой ─────────────────────────────────────────────────

  /**
   * Применить пресет: собрать сцену, прогреть, обновить интерфейс.
   *
   * Пресет — это ПЕСОЧНИЦА, а не уровень: применение пресета выходит из
   * кампании. Без этого получалось рассогласование — сцена уже другая, а
   * подсказка и проверки остались от прежнего уровня, и «пройден» мог
   * засчитаться не тот уровень, который открыт.
   */
  applyPreset(preset: Preset): void {
    this.state.presetId = preset.id;
    this.state.model = preset.model;
    this.state.spatial = preset.topology.kind === 'grid';
    this.state.view.colorMode = preset.colorMode;
    this.state.levelId = null;

    this.scene = buildScene(preset);
    warmUp(this.scene);
    this.renderer.options.colorMode = this.state.view.colorMode;
    this.renderer.invalidateLinks();
    this.trajectory = [];
    this.session = null;
    this.lastReport = null;
    // Результат опыта относится к ПРЕДЫДУЩЕЙ сцене: оставлять его на экране
    // после смены сцены значило бы показывать числа от другой сети.
    this.experiment = null;
    this.experimentControl = null;
    this.renderExperiment();
    if (this.reportHost) this.reportHost.replaceChildren();
    if (this.theoryHost) this.theoryHost.replaceChildren();

    this.fitCamera();
    this.syncHud();
    // Радиус кисти пересчитывается ПОСЛЕ смены сцены: он задан в шагах
    // между нейронами, а шаг зависит от пресета.
    this.syncBrushRadius();
    // Ползунки сети возвращаются к значениям НОВОГО пресета: иначе подписи
    // показывали бы «2.0×» и «20 %» от прошлой сцены, а сеть считала бы
    // ровно то, что задано в пресете — интерфейс расходился бы с данными.
    this.syncNetworkControls();
    this.updatePresetButtons();
    this.updateModelToggle();
    this.updateColorToggle();
  }

  /** Сбросить текущую сцену к исходному состоянию. */
  resetScene(): void {
    const preset = this.state.presetId ? presetById(this.state.presetId) : undefined;
    if (preset) this.applyPreset(preset);
  }

  /** Подогнать камеру под содержимое сцены. */
  private fitCamera(): void {
    const network = this.scene.network;
    if (this.state.spatial) {
      let maxX = 0;
      let maxY = 0;
      for (let i = 0; i < network.params.count; i++) {
        if (network.x[i] > maxX) maxX = network.x[i];
        if (network.y[i] > maxY) maxY = network.y[i];
      }
      this.renderer.camera.x = maxX / 2;
      this.renderer.camera.y = maxY / 2;
      this.renderer.camera.fit(maxX + 1, maxY + 1, 0.05);
      return;
    }

    // ─── Раскладка не-пространственных сцен ─────────────────────────────
    //
    // КОЛЬЦО раскладывается ПО ОКРУЖНОСТИ, а не по диску. Топология
    // «кольцо» — это цикл (нейрон i связан с i+1), и на диске дуга цикла
    // рисуется хордой через центр: волна, бегущая по кольцу, выглядела как
    // паутина через середину, а не как бегущий по кругу фронт. Обнаружено
    // на скриншоте пресета после починки самоподдержки.
    if (this.scene.preset.topology.kind === 'ring') {
      const count = network.params.count;
      // Радиус такой, чтобы точки не сливались: длина окружности должна
      // вместить count точек с зазором.
      const radius = Math.max(2, count / (2 * Math.PI));
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        network.x[i] = Math.cos(angle) * radius;
        network.y[i] = Math.sin(angle) * radius;
      }
      this.renderer.camera.x = 0;
      this.renderer.camera.y = 0;
      this.renderer.camera.fit(radius * 2.4, radius * 2.4, 0.06);
      return;
    }

    // Остальные не-пространственные сцены — диск спиралью Ван дер Корпута:
    // так площадь заполняется равномерно, и точки не слипаются.
    //
    // Первая версия раскладывала их по ТРЁМ окружностям с радиусами
    // 1, 1.35 и 1.7 от базового. При 800 нейронах и вспышках спайков
    // вся сеть собиралась в сплошной светлый диск: на экране не было видно
    // ни отдельных нейронов, ни структуры. Это обнаружилось на витринном
    // кадре — «работает, но нечитаемо».
    const count = network.params.count;
    const radius = Math.max(2, Math.sqrt(count) * 0.9);
    for (let i = 0; i < count; i++) {
      // Радиус растёт как корень из доли площади, угол — золотым углом.
      const fraction = (i + 0.5) / count;
      const r = radius * Math.sqrt(fraction);
      const angle = i * 2.399963229728653; // золотой угол, радианы
      network.x[i] = Math.cos(angle) * r;
      network.y[i] = Math.sin(angle) * r;
    }
    this.renderer.camera.x = 0;
    this.renderer.camera.y = 0;
    this.renderer.camera.fit(radius * 2.2, radius * 2.2, 0.06);
  }

  /** Сменить модель нейрона. */
  setModel(model: 'lif' | 'izhikevich'): boolean {
    const preset = this.state.presetId ? presetById(this.state.presetId) : undefined;
    if (!preset) return false;
    // Одиночные сцены каталога привязаны к своей модели: подменять им
    // модель значило бы потерять смысл режима.
    if (preset.count === 1) return false;
    this.state.model = model;
    this.applyPreset({ ...preset, model });
    return true;
  }

  /** Сменить внешний вход. */
  setInput(mode: 'const' | 'poisson' | 'none', amplitude?: number): void {
    const network = this.scene.network;
    network.params.input.mode = mode;
    if (amplitude !== undefined) network.params.input.amplitude = amplitude;
  }

  private syncHud(): void {
    const preset = this.scene.preset;
    const level = this.state.levelId ? levelById(this.state.levelId) : undefined;
    this.hudTitle.textContent = level
      ? `Уровень ${level.id.slice(-2)}: ${level.title}`
      : preset.title;
    this.hudHint.textContent = level ? level.task : preset.hint;
    this.hudProgress.parentElement?.classList.toggle('hud__progress--hidden', !level);
  }

  private updatePresetButtons(): void {
    for (const btn of this.sidebar.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
      btn.classList.toggle('btn--on', btn.dataset['preset'] === this.state.presetId);
    }
  }

  private updateModelToggle(): void {
    for (const btn of this.sidebar.querySelectorAll<HTMLButtonElement>('.toggle__item')) {
      const label = btn.textContent ?? '';
      if (label === 'LIF' || label === 'Izhikevich') {
        btn.classList.toggle('toggle__item--on', label.toLowerCase() === this.state.model);
      }
    }
  }

  /**
   * Показать в панели «Раскраска» тот режим, который реально включён.
   *
   * Пресет задаёт раскраску сам, и без этого панель продолжала подсвечивать
   * «Потенциал», пока сцена рисовалась по спайкам. Расхождение панели и
   * сцены — тот же класс дефектов, что «нет данных выглядит как ноль»:
   * интерфейс утверждает то, чего нет.
   */
  private updateColorToggle(): void {
    const names: Record<string, string> = {
      potential: 'Потенциал',
      spike: 'Спайки',
      type: 'Тип',
      rate: 'Частота',
    };
    const active = names[this.state.view.colorMode];
    for (const btn of this.sidebar.querySelectorAll<HTMLButtonElement>('.toggle__item')) {
      const label = btn.textContent ?? '';
      // Кнопки моделей обрабатываются отдельно — здесь только раскраска.
      if (label === 'LIF' || label === 'Izhikevich') continue;
      if (Object.values(names).includes(label)) {
        btn.classList.toggle('toggle__item--on', label === active);
      }
    }
  }

  // ─── Уровни ────────────────────────────────────────────────────────────

  /** Начать уровень. */
  startLevel(level: Level): void {
    const preset = presetById(level.presetId);
    if (!preset) return;
    this.applyPreset(preset);
    this.state.levelId = level.id;
    this.session = new LevelSession(level, this.scene.network);
    if (this.state.spatial) this.session.setWaveCentre(this.waveCentre());
    this.renderLevelList();
    this.syncHud();
    this.showTheory(level);
  }

  private waveCentre(): { centerX: number; centerY: number } {
    const network = this.scene.network;
    let maxX = 0;
    let maxY = 0;
    for (let i = 0; i < network.params.count; i++) {
      if (network.x[i] > maxX) maxX = network.x[i];
      if (network.y[i] > maxY) maxY = network.y[i];
    }
    return { centerX: maxX / 2, centerY: maxY / 2 };
  }

  /** Показать теорию и подсказки уровня. */
  private showTheory(level: Level): void {
    if (!this.theoryHost) return;
    this.theoryHost.replaceChildren();
    for (const paragraph of level.theory.split('\n\n')) {
      if (paragraph.startsWith('•')) {
        const list = h('ul', {});
        for (const line of paragraph.split('\n')) {
          if (line.trim().length === 0) continue;
          list.append(h('li', {}, line.replace(/^•\s*/, '')));
        }
        this.theoryHost.append(list);
      } else {
        this.theoryHost.append(h('p', {}, paragraph));
      }
    }
    for (const hint of level.hints) {
      this.theoryHost.append(h('div', { class: 'hint' }, `• ${hint}`));
    }
  }

  private exitToSandbox(): void {
    this.state.levelId = null;
    this.session = null;
    this.lastReport = null;
    if (this.reportHost) this.reportHost.replaceChildren();
    if (this.theoryHost) this.theoryHost.replaceChildren();
    this.renderLevelList();
    this.syncHud();
  }

  /** Отрисовать отчёт по уровню в боковой панели. */
  private showReport(report: LevelReport): void {
    if (!this.reportHost) return;
    this.reportHost.replaceChildren();
    this.reportHost.append(
      h(
        'div',
        { class: report.passed ? 'report--ok' : 'report--bad' },
        report.passed ? '✓ Уровень пройден' : '· Условия пока не выполнены',
      ),
    );
    for (const result of report.results) {
      this.reportHost.append(
        h(
          'div',
          { class: `report__row ${result.passed ? 'report--ok' : 'report--bad'}` },
          h('span', { class: 'report__mark' }, result.passed ? '✓' : '×'),
          h(
            'span',
            {},
            h('div', {}, result.check.label),
            h('div', { class: 'report__detail' }, result.detail),
          ),
        ),
      );
    }
    if (report.passed) this.completedLevels.add(report.levelId);
    this.renderLevelList();
  }

  // ─── Цикл ──────────────────────────────────────────────────────────────

  private toggleRun(): void {
    this.state.running = !this.state.running;
    for (const btn of this.host.querySelectorAll<HTMLButtonElement>('[data-action="run"]')) {
      btn.textContent = this.state.running ? 'Пауза' : 'Продолжить';
      btn.classList.toggle('btn--on', !this.state.running);
    }
  }

  private stepOnce(): void {
    const wasRunning = this.state.running;
    this.state.running = false;
    this.runSteps(1);
    this.state.running = wasRunning;
    // Короткая подсветка: один шаг визуально почти ничего не меняет, и без
    // отклика нажатие выглядит «пустым».
    const btn = this.host.querySelector<HTMLButtonElement>('[data-action="step"]');
    if (btn) {
      btn.classList.add('btn--flash');
      window.setTimeout(() => btn.classList.remove('btn--flash'), 120);
    }
  }

  /** Продвинуть симуляцию на заданное число шагов и обновить приборы. */
  runSteps(count: number): void {
    const network = this.scene?.network;
    if (!network) return;

    const startedAt = performance.now();
    network.run(count);
    // Замер ТОЛЬКО шагов симуляции: приборы сюда не входят.
    this.stepCostMs = (performance.now() - startedAt) / Math.max(1, count);

    if (this.session) this.session.tick();
    this.updateInstruments();
    this.maybeCheckLevel();
  }

  /** Один кадр приложения. */
  private frame(): void {
    const network = this.scene?.network;
    if (!network) return;

    const now = performance.now();
    const frameMs = now - this.lastFrameAt;
    this.lastFrameAt = now;
    this.frameAccumulator += frameMs;

    if (this.state.running) {
      const steps = this.autoSteps();
      this.currentStepsPerFrame = steps;
      const startedAt = performance.now();
      network.run(steps);
      // Замер только шагов: см. комментарий про дефект 19 в NEXT-SESSION.
      this.stepCostMs = (performance.now() - startedAt) / Math.max(1, steps);
      if (this.session) this.session.tick();
    }

    this.renderer.render(network, {
      gridSpan: this.state.spatial ? this.gridSpan() : undefined,
    });

    // Кольцо кисти — ПОСЛЕ рендера сцены: оно должно оказаться поверх
    // нейронов, иначе его закроют точки.
    this.renderer.setBrush(this.input?.brush ?? null);

    this.instrumentAccumulator += frameMs;
    if (this.instrumentAccumulator >= 50) {
      this.instrumentAccumulator = 0;
      this.updateInstruments();
    }

    this.maybeCheckLevel();

    if (this.frameAccumulator >= 500) {
      this.frameAccumulator = 0;
      this.updateStats();
      this.updateProgress();
    }
  }

  /**
   * Сколько шагов делать в этом кадре.
   *
   * Автоподстройка опирается на ИЗМЕРЕННУЮ стоимость шага: если один шаг
   * дороже бюджета кадра, число шагов уменьшается.
   */
  private autoSteps(): number {
    const count = this.scene.network.params.count;
    if (!this.state.autoSteps) return this.state.stepsPerFrame;
    if (this.stepCostMs <= 0) {
      // Первый кадр: оценка по числу нейронов. Делится на число нейронов,
      // но НЕ больше 200 шагов: для одиночного нейрона формула дала бы
      // 20 000 шагов за кадр — это 10 секунд модельного времени в одном
      // кадре, то есть «прыжок сквозь время», а не наблюдение.
      const estimate = Math.round(20000 / Math.max(1, count));
      return Math.max(1, Math.min(200, estimate));
    }
    // Бюджет: не больше 12 мс на шаги симуляции — остальное нужно рендеру.
    const affordable = Math.floor(12 / Math.max(0.001, this.stepCostMs));
    // Верхняя граница 200 шагов: при dt = 0.5 мс это 100 мс модельного
    // времени за кадр. Больше не нужно ни для какой сцены, а прыжок на
    // сотни миллисекунд ломает восприятие времени — волна успевает
    // проскочить весь экран между кадрами.
    return Math.max(1, Math.min(200, affordable));
  }

  /** Размер пространственной решётки. */
  private gridSpan(): number {
    const network = this.scene.network;
    let max = 0;
    for (let i = 0; i < network.params.count; i++) {
      if (network.x[i] > max) max = network.x[i];
      if (network.y[i] > max) max = network.y[i];
    }
    return max;
  }

  /** Проверить уровень, если время наблюдения набрано. */
  private maybeCheckLevel(): void {
    if (!this.session || this.session.isCompleted) return;
    const now = performance.now();
    if (now - this.lastLevelPoll < LEVEL_POLL_MS) return;
    this.lastLevelPoll = now;
    const report = this.session.check();
    if (!report) return;
    this.lastReport = report;
    this.showReport(report);
  }

  // ─── Своя сеть ─────────────────────────────────────────────────────────

  /** Текущие параметры «своей сети». */
  private custom: CustomNetworkOptions = { ...DEFAULT_CUSTOM };

  /**
   * Построить панель сборки сети.
   *
   * Возвращается массивом, потому что всё содержимое создаётся здесь же:
   * держать разметку и обработчики в разных местах значило бы однажды
   * разойтись в том, какой ползунок на что влияет.
   */
  private buildCustomPanel(): HTMLElement[] {
    const controls: Array<{ set(value: number): void }> = [];
    const field = (
      label: string,
      key: keyof CustomNetworkOptions,
      min: number,
      max: number,
      step: number,
      format?: (value: number) => string,
    ): HTMLElement => {
      const control = rangeControl({
        label,
        min,
        max,
        step,
        value: Number(this.custom[key]),
        ...(format ? { format } : {}),
        onInput: (value) => {
          (this.custom[key] as number) = value;
        },
      });
      controls.push(control);
      return control.root;
    };

    const topologyControl = toggleControl<CustomNetworkOptions['topology']>({
      label: 'Структура',
      value: this.custom.topology,
      items: CUSTOM_TOPOLOGIES.map((item) => ({ id: item.id, label: item.label, title: item.hint })),
      onChange: (value) => {
        this.custom.topology = value;
        this.updateCustomHint();
      },
    });

    const stdpCheck = checkbox({
      label: 'Обучение STDP',
      checked: this.custom.stdp,
      onChange: (checked) => {
        this.custom.stdp = checked;
      },
    });

    const hint = h('div', { class: 'hint', 'data-custom-hint': 'topology' });
    const build = button('Собрать сеть', () => this.buildCustom(), {
      class: 'btn--primary',
      'data-action': 'build-custom',
    });

    const panel = h(
      'div',
      { 'data-section': 'custom' },
      h(
        'div',
        { class: 'hint' },
        'Задайте структуру и нажмите «Собрать сеть» — сцена будет построена ' +
          'заново из ваших чисел. Это песочница: явлений здесь никто не обещает.',
      ),
      topologyControl.root,
      hint,
      field('Нейронов', 'count', 20, 2000, 20),
      field('Связей', 'connectionProbability', 0.01, 1, 0.01, (v) => `${Math.round(v * 100)} %`),
      field('Вес связи', 'excitatoryWeight', 0.05, 8, 0.05, (v) => v.toFixed(2)),
      field('Торможение', 'inhibitoryFraction', 0, 0.5, 0.05, (v) => `${Math.round(v * 100)} %`),
      field('Сила тормоза', 'inhibitoryRatio', 1, 10, 0.5, (v) => `${v.toFixed(1)}×`),
      field('Фоновый вход', 'inputRate', 0, 600, 25, (v) => (v > 0 ? `${v} Гц` : 'нет')),
      stdpCheck,
      h('div', { class: 'btn-row' }, build),
    );

    // Значения ползунков синхронизируются при пересборке пресета, поэтому
    // список контролов сохраняется: иначе подписи показывали бы одно, а
    // сеть была собрана по другому.
    this.customControls = controls;
    this.customHint = hint;
    this.updateCustomHint();
    return [panel];
  }

  /** Обновить пояснение к выбранной структуре. */
  private updateCustomHint(): void {
    if (!this.customHint) return;
    const item = CUSTOM_TOPOLOGIES.find((entry) => entry.id === this.custom.topology);
    this.customHint.textContent = item ? item.hint : '';
  }

  /**
   * Собрать сеть по параметрам панели.
   *
   * Возвращается ФАКТ: если сеть получилась молчащей, так и написано — без
   * этого «собрал сеть» означало бы «нажал кнопку», а не «получил результат».
   */
  private buildCustom(): void {
    const preset = customPreset(this.custom);
    this.applyPreset(preset);
    this.state.customBuilt = true;
    // Ползунки возвращаются к значениям, по которым сеть СОБРАНА, а не к
    // тому, что на них успел выставить пресет: `applyPreset` вызывает
    // `syncNetworkControls`, и без этого шага подписи разошлись бы с сетью.
    const values = [
      this.custom.count,
      this.custom.connectionProbability,
      this.custom.excitatoryWeight,
      this.custom.inhibitoryFraction,
      this.custom.inhibitoryRatio,
      this.custom.inputRate,
    ];
    this.customControls?.forEach((control, index) => {
      if (values[index] !== undefined) control.set(values[index]);
    });
    this.updateStats();
  }

  // ─── Приборы ───────────────────────────────────────────────────────────

  private updateInstruments(): void {
    const network = this.scene.network;

    if (this.oscilloscopeCanvas) {
      drawOscilloscope(this.oscilloscopeCanvas, this.buildTraces(network), {
        threshold: network.params.neuron.model === 'lif' ? network.params.neuron.lif.vTh : 30,
        reset: network.params.neuron.model === 'lif' ? network.params.neuron.lif.vReset : -65,
        windowMs: OSCILLOSCOPE_WINDOW_MS,
      });
    }

    if (this.rasterCanvas) {
      const now = network.state.time;
      drawRaster(this.rasterCanvas, network.spikeHistory, {
        fromMs: Math.max(0, now - 1000),
        toMs: Math.max(1, now),
        neuronCount: network.params.count,
      });
    }

    this.trajectory.push({ time: network.state.time, rate: this.currentRate(network) });
    if (this.trajectory.length > 600) this.trajectory.shift();

    // ─── График частоты популяции ────────────────────────────────────────
    // Третья серия — порог «сеть молчит» (1 Гц): по нему сразу видно,
    // работает сеть или погасла, без чтения чисел из сводки.
    if (this.rateCanvas) {
      drawPlot(this.rateCanvas, {
        title: 'Частота популяции',
        unit: 'Гц',
        series: [
          {
            label: 'частота',
            color: PLOT_COLORS.rate,
            times: this.trajectory.map((point) => point.time),
            values: this.trajectory.map((point) => point.rate),
            fill: true,
            width: 1.4,
          },
        ],
        guide: { value: 1, label: 'молчание', color: PLOT_COLORS.guide },
      });
    }
  }

  /**
   * Мгновенная частота популяции, Гц — по СКОЛЬЗЯЩЕМУ окну.
   *
   * ─── Почему не среднее за прогон ─────────────────────────────────────────
   *
   * Первая версия делила накопленное число спайков на ВСЁ прошедшее время.
   * Это среднее за прогон, и оно почти не зависит от того, что происходит
   * сейчас: измерено на кольце — 19.8, 25.4, 30.6, 35.8, 40.9, 46.1 Гц по
   * ходу прогона. Кривая растёт ровно потому, что среднее «догоняет»
   * установившийся режим, а не потому что сеть разгоняется.
   *
   * На графике это выглядело как плавный подъём, хотя сеть уже вышла на
   * постоянную частоту (оконная мера даёт ровные 30.9, 41.1, 51.4 — и
   * выходит на ту же полку). То есть график показывал АРТЕФАКТ УСРЕДНЕНИЯ
   * вместо динамики — ровно та ошибка, от которой предупреждает README
   * («нет данных» не должно выглядеть как данные).
   *
   * Теперь берётся окно последних `RATE_WINDOW_MS` модельного времени из
   * истории спайков: у погасшей сети кривая падает к нулю, у разгоняющейся
   * растёт, у установившейся стоит на месте.
   */
  private currentRate(network: Network): number {
    const now = network.state.time;
    const from = Math.max(0, now - RATE_WINDOW_MS);
    const spanMs = Math.max(1e-9, now - from);
    const spikes = network.spikeHistory.countIn(from, now);
    return (spikes / network.params.count / spanMs) * 1000;
  }

  /**
   * Построить дорожки осциллографа.
   *
   * Берутся нейроны с наибольшим числом спайков: у случайной сети
   * подавляющее большинство молчит, и первые по индексу дорожки были бы
   * прямыми линиями. Это делает осциллограф бесполезным — ровно тот класс
   * дефектов, который в phys-lab назывался «нет данных выглядит как ноль».
   */
  private buildTraces(network: Network): Trace[] {
    const count = network.params.count;
    const indices: number[] = [];
    if (count === 1) {
      indices.push(0);
    } else {
      const candidates: Array<{ index: number; spikes: number }> = [];
      for (let i = 0; i < count; i++) {
        candidates.push({ index: i, spikes: network.state.spikeCount[i] });
      }
      candidates.sort((a, b) => b.spikes - a.spikes);
      for (let i = 0; i < Math.min(3, candidates.length); i++) {
        if (candidates[i].spikes > 0) indices.push(candidates[i].index);
      }
    }

    const now = network.state.time;
    const from = Math.max(0, now - OSCILLOSCOPE_WINDOW_MS * 2);
    const colors = ['#f2a65a', '#6fb3e0', '#7fd6c0'];
    const lif = network.params.neuron.lif;
    const izh = network.params.neuron.izh;

    return indices.map((index, order) => {
      const times: number[] = [];
      const values: number[] = [];
      const spikeTimes = network.spikeHistory.timesOf(index).filter((time) => time >= from);
      // Кривая строится по спайкам: между разрядами потенциал идёт от покоя
      // к порогу. Точная форма доступна только в момент записи, поэтому
      // используется линейная реконструкция — её достаточно, чтобы видеть
      // частоту и регулярность разряда.
      for (const time of spikeTimes) {
        const isi = network.state.meanIsi[index];
        const period = Number.isFinite(isi) && isi > 0 ? isi : 50;
        const vRest = network.params.neuron.model === 'lif' ? lif.vRest : izh.vRest;
        const vTh = network.params.neuron.model === 'lif' ? lif.vTh : izh.vPeak;
        const start = Math.max(from, time - period);
        times.push(start, time);
        values.push(vRest, vTh);
      }
      return {
        label: `нейрон ${index}`,
        color: colors[order % colors.length],
        times,
        values,
        spikeTimes,
      };
    });
  }

  /** Обновить сводку в боковой панели. */
  private updateStats(): void {
    if (!this.statHost) return;
    const network = this.scene.network;
    let total = 0;
    let active = 0;
    for (let i = 0; i < network.params.count; i++) {
      total += network.state.spikeCount[i];
      if (network.state.spikeCount[i] > 0) active += 1;
    }
    const sample = network.recordSample();
    const set = (label: string, value: string): void => {
      const el = this.statHost?.querySelector<HTMLElement>(`[data-stat="${label}"]`);
      if (el) el.textContent = value;
    };

    set('время', format.time(network.state.time));
    set('спайков', format.int(total));
    set('частота', `${format.maybe(sample.rate, 2)} Гц`);
    set('активных', `${format.int(active)} / ${format.int(network.params.count)}`);
    // «Набор…» вместо нуля: пока данных мало, CV не определён, и показывать
    // 0 значило бы утверждать регулярность, которой никто не измерял.
    set('CV ISI', format.maybe(sample.cv, 2));
    set('синхронность', format.maybe(sample.synchrony, 3));
    set('связей', format.int(network.synapses.synapseCount));
    set('обучений', format.int(network.stdpUpdates));

    const speed = this.host.querySelector<HTMLElement>('[data-stat="скорость"]');
    if (speed) {
      speed.textContent = `${this.currentStepsPerFrame} (${this.stepCostMs.toFixed(2)} мс/шаг)`;
    }
  }

  /** Обновить полосу прогресса наблюдения. */
  private updateProgress(): void {
    const bar = this.hudProgress.firstElementChild as HTMLElement | null;
    if (!bar) return;
    bar.style.width = this.session ? `${(this.session.progress * 100).toFixed(1)}%` : '0%';
  }

  private resize(): void {
    const rect = this.stageHost.getBoundingClientRect();
    this.renderer.resize(
      Math.max(320, Math.floor(rect.width)),
      Math.max(240, Math.floor(rect.height)),
    );
    // Камеру надо подогнать ЗАНОВО: `applyPreset` при первом запуске
    // выполняется ДО того, как сцена получила настоящий размер, и подгонка
    // считалась по исходным 800×600. Из-за этого сеть оказывалась не по
    // центру и не в масштабе окна. Обнаружено измерением геометрии:
    // камера сообщала зум, посчитанный для другого размера.
    this.fitCamera();
  }

  /** Собрать диагностику для сквозных проверок. */
  private probe(): ReturnType<NeuroLabApi['probe']> {
    const network = this.scene.network;
    const elapsed = Math.max(1, network.state.time);
    let total = 0;
    let active = 0;
    for (let i = 0; i < network.params.count; i++) {
      total += network.state.spikeCount[i];
      if (network.state.spikeCount[i] > 0) active += 1;
    }
    const sample = network.recordSample();
    const stats = this.renderer.stats;
    return {
      neuronCount: network.params.count,
      synapseCount: network.synapses.synapseCount,
      spikesTotal: total,
      stdpUpdates: network.stdpUpdates,
      renderDrawn: stats.drawn,
      renderFlashes: stats.flashes,
      renderPulses: stats.pulses,
      pulseEvents: network.pulses.size,
      pulsesRecorded: network.pulses.recorded,
      spotActive: network.spotActive,
      timeMs: network.state.time,
      synchrony: network.synchronyValue(),
      meanRate: (total / network.params.count / elapsed) * 1000,
      activeFraction: network.params.count > 0 ? active / network.params.count : 0,
      cv: sample.cv,
      insane: network.state.insane,
      running: this.state.running,
      stepsPerFrame: this.currentStepsPerFrame,
    };
  }

  /**
   * Закрыть справку, если она открыта.
   *
   * Нужно автоматическим проверкам и витрине: при первом запуске справка
   * показывается сама и накрывает сцену.
   */
  private closeHelp(): void {
    const overlay = this.host.ownerDocument.querySelector('.overlay');
    if (overlay) overlay.remove();
  }

  /** Справка. */
  private openHelp(): void {
    if (this.host.ownerDocument.querySelector('.overlay')) return;
    const box = h('div', { class: 'overlay__box' });
    box.append(
      h('h2', {}, 'Neuro Lab — спайковые нейронные сети'),
      h(
        'p',
        {},
        'Симулятор живого мозга на минимальном уровне: нейроны с мембранным ' +
          'потенциалом обмениваются спайками, и из простых правил возникают ' +
          'синхронизация, волны активности и обучение. Явления здесь не ' +
          'запрограммированы — они ВОЗНИКАЮТ.',
      ),

      // ─── Главное: что с этим делать ────────────────────────────────────
      //
      // Раньше справка начиналась с таблицы приборов — то есть отвечала на
      // вопрос «что я вижу», но не на вопрос «что мне делать». Пользователь
      // дважды сообщал, что непонятно, ЧТО с проектом делать, и это точный
      // признак: интерфейс описывал себя, а не давал путь.
      //
      // Поэтому первым идёт конкретный маршрут с ожидаемым результатом, а
      // таблица приборов уехала ниже — она нужна ПОСЛЕ того, как человек
      // понял, зачем смотреть.
      h('h3', {}, 'С чего начать — три пути'),
      h(
        'ol',
        { class: 'overlay__steps' },
        h(
          'li',
          {},
          h('b', {}, 'Посмотреть явления. '),
          'Нажимайте кнопки в панели «Сцены» слева: каждая — готовый опыт. ' +
            '«Один нейрон» — пила потенциала на осциллографе. «Волна активности» — ' +
            'кольцо возбуждения, расходящееся по решётке. «Кольцо» — сеть, ' +
            'работающая генератором. Тяните мышью по сцене в любой момент: ' +
            'под курсором нейроны получают удар током.',
        ),
        h(
          'li',
          {},
          h('b', {}, 'Собрать свою сеть. '),
          'Панель «Своя сеть» пересобирает сцену по вашим числам: сколько ' +
            'нейронов, какая топология, плотность и сила связей, доля ' +
            'торможения. Меняйте по одному параметру и смотрите, что станет ' +
            'с частотой и с картиной на растровой диаграмме.',
        ),
        h(
          'li',
          {},
          h('b', {}, 'Обучить и увидеть результат. '),
          'На панели «Опыт» есть кнопка «Прогнать опыт»: сеть учат различать ' +
            'два паттерна, а затем ИЗМЕРЯЮТ, отвечает ли она на обученный ' +
            'паттерн сильнее, чем на необученный. Рядом считается контроль с ' +
            'выключенным обучением — он показывает, что без обучения эффекта ' +
            'нет. Это ответ на вопрос «а обучение вообще что-то даёт?»',
        ),
      ),

      h('h3', {}, 'Что видно'),
      h(
        'table',
        {},
        h('tr', {}, h('th', {}, 'Прибор'), h('th', {}, 'Что показывает')),
        h('tr', {}, h('td', {}, 'Сцена'), h('td', {}, 'Нейроны вспыхивают в момент спайка')),
        h(
          'tr',
          {},
          h('td', {}, 'Осциллограф'),
          h('td', {}, 'Потенциал одного нейрона во времени, с порогом и сбросом'),
        ),
        h(
          'tr',
          {},
          h('td', {}, 'Растровая диаграмма'),
          h('td', {}, 'Время слева направо, нейроны снизу вверх: точка = спайк'),
        ),
        h(
          'tr',
          {},
          h('td', {}, 'График частоты'),
          h('td', {}, 'Частота всей популяции во времени; пунктир — порог «сеть молчит»'),
        ),
      ),

      h('h3', {}, 'Управление'),
      h(
        'ul',
        {},
        h('li', {}, 'Пауза и шаг — в верхней панели (пробел и точка на клавиатуре).'),
        h('li', {}, 'Сцены переключаются кнопками в боковой панели.'),
        h('li', {}, 'STDP включается и выключается флажком «Обучение».'),
        h(
          'li',
          {},
          'Кампания (внизу панели) ведёт от одного нейрона до рабочей памяти: ' +
            '8 уровней с теорией и автопроверкой.',
        ),
      ),

      h('h3', {}, 'Работа со сценой'),
      h(
        'ul',
        {},
        h(
          'li',
          {},
          'Тяните мышью по сцене — «удар током» идёт за курсором и ' +
            'возбуждает нейроны в радиусе кисти. Радиус и сила — в панели «Стимул».',
        ),
        h('li', {}, 'Колесо мыши — масштаб, Shift + протяжка или средняя кнопка — сдвиг сцены.'),
        h(
          'li',
          {},
          'Флажок «Импульсы» показывает, как спайки бегут по синапсам: ' +
            'бирюзовые отрезки — возбуждающие связи, сиреневые — тормозные.',
        ),
        h(
          'li',
          {},
          'Панель «Сеть» меняет вес связей (множителем), долю торможения и ' +
            'амплитуду входа — прямо на текущей сцене. «Сброс» вернёт исходные ' +
            'значения пресета.',
        ),
      ),

      h('h3', {}, 'Чего здесь нет — чтобы не искать'),
      h(
        'ul',
        {},
        h(
          'li',
          {},
          'Это НЕ распознавание цифр и не «обучение с учителем до точности». ' +
            'Проект про эмерджентное поведение и измеримые явления.',
        ),
        h(
          'li',
          {},
          'Модель нейрона — LIF и Izhikevich, а не Hodgkin-Huxley: формы ' +
            'спайка как в реальной клетке здесь не будет.',
        ),
        h(
          'li',
          {},
          'Ритм в гамма-диапазоне (30–80 Гц) пока не воспроизводится — это ' +
            'записано как известное ограничение, а не спрятано.',
        ),
      ),
      h(
        'p',
        { class: 'hint' },
        'Проект написан ИИ-агентом: код рабочий, но возможны шероховатости. ' +
          'Подробности, измерения и история дефектов — в README и docs/NEXT-SESSION.md.',
      ),
    );
    const overlay = h('div', { class: 'overlay', on: { click: () => overlay.remove() } });
    overlay.append(box);
    this.host.ownerDocument.body.append(overlay);
  }
}
