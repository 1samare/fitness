import { describe, expect, it } from 'vitest';

interface ExerciseDefinition {
  readonly id: string;
  readonly nameZh: string;
  readonly aliases: readonly string[];
  readonly movementPattern: string;
  readonly primaryMuscles: readonly string[];
  readonly secondaryMuscles: readonly string[];
  readonly equipment: readonly string[];
  readonly difficulty: 'beginner' | 'intermediate' | 'advanced';
  readonly steps: readonly string[];
  readonly commonErrors: readonly string[];
  readonly caution: string;
  readonly supportedSessionIntensities: readonly ('moderate' | 'vigorous')[];
}

interface ExerciseCatalog {
  readonly datasetVersion: string;
  readonly sourceId: string;
  readonly reviewedAt: string;
  readonly exercises: readonly ExerciseDefinition[];
}

async function catalogModule() {
  const module: Record<string, unknown> = await import('./exercise-catalog').catch(() => ({}));
  expect(module.EXERCISE_CATALOG_V1, 'EXERCISE_CATALOG_V1 must be exported').toBeDefined();
  expect(module.findExerciseById, 'findExerciseById must be exported').toBeTypeOf('function');
  expect(module.isReviewedExerciseId, 'isReviewedExerciseId must be exported').toBeTypeOf('function');
  return {
    catalog: module.EXERCISE_CATALOG_V1 as ExerciseCatalog,
    findExerciseById: module.findExerciseById as (id: string) => ExerciseDefinition | undefined,
    isReviewedExerciseId: module.isReviewedExerciseId as (id: string) => boolean
  };
}

const EXPECTED_EXERCISES = [
  ['back-squat', '深蹲'],
  ['front-squat', '前蹲'],
  ['goblet-squat', '高脚杯深蹲'],
  ['split-squat', '分腿蹲'],
  ['bulgarian-split-squat', '保加利亚分腿蹲'],
  ['reverse-lunge', '后撤箭步蹲'],
  ['walking-lunge', '行走箭步蹲'],
  ['lateral-lunge', '侧向箭步蹲'],
  ['step-up', '登阶'],
  ['leg-press', '腿举'],
  ['hack-squat', '哈克深蹲'],
  ['leg-extension', '腿屈伸'],
  ['lying-leg-curl', '俯卧腿弯举'],
  ['seated-leg-curl', '坐姿腿弯举'],
  ['conventional-deadlift', '传统硬拉'],
  ['sumo-deadlift', '相扑硬拉'],
  ['romanian-deadlift', '罗马尼亚硬拉'],
  ['single-leg-rdl', '单腿罗马尼亚硬拉'],
  ['good-morning', '早安式'],
  ['hip-thrust', '臀推'],
  ['glute-bridge', '臀桥'],
  ['standing-calf-raise', '站姿提踵'],
  ['seated-calf-raise', '坐姿提踵'],
  ['barbell-bench-press', '杠铃卧推'],
  ['dumbbell-bench-press', '哑铃卧推'],
  ['incline-bench-press', '上斜卧推'],
  ['decline-bench-press', '下斜卧推'],
  ['push-up', '俯卧撑'],
  ['parallel-bar-dip', '双杠臂屈伸'],
  ['chest-fly', '胸飞鸟'],
  ['cable-crossover', '绳索夹胸'],
  ['barbell-overhead-press', '杠铃推举'],
  ['dumbbell-shoulder-press', '哑铃肩推'],
  ['arnold-press', '阿诺德推举'],
  ['lateral-raise', '侧平举'],
  ['front-raise', '前平举'],
  ['reverse-fly', '反向飞鸟'],
  ['face-pull', '面拉'],
  ['upright-row', '直立划船'],
  ['pull-up', '引体向上'],
  ['chin-up', '反手引体向上'],
  ['lat-pulldown', '高位下拉'],
  ['seated-cable-row', '坐姿划船'],
  ['barbell-row', '杠铃划船'],
  ['one-arm-dumbbell-row', '单臂哑铃划船'],
  ['chest-supported-row', '胸托划船'],
  ['inverted-row', '反向划船'],
  ['straight-arm-pulldown', '直臂下压'],
  ['dumbbell-pullover', '哑铃上拉'],
  ['barbell-shrug', '杠铃耸肩'],
  ['barbell-curl', '杠铃弯举'],
  ['dumbbell-curl', '哑铃弯举'],
  ['hammer-curl', '锤式弯举'],
  ['incline-dumbbell-curl', '上斜哑铃弯举'],
  ['preacher-curl', '牧师凳弯举'],
  ['triceps-pushdown', '肱三头肌下压'],
  ['overhead-triceps-extension', '过顶臂屈伸'],
  ['skull-crusher', '仰卧臂屈伸'],
  ['close-grip-bench-press', '窄握卧推'],
  ['plank', '平板支撑'],
  ['side-plank', '侧平板支撑'],
  ['dead-bug', '死虫式'],
  ['bird-dog', '鸟狗式'],
  ['hollow-hold', '中空支撑'],
  ['hanging-knee-raise', '悬垂举膝'],
  ['reverse-crunch', '反向卷腹'],
  ['ab-wheel-rollout', '健腹轮'],
  ['pallof-press', '帕洛夫抗旋推'],
  ['farmer-carry', '农夫行走'],
  ['suitcase-carry', '单侧提重行走'],
  ['kettlebell-deadlift', '壶铃硬拉'],
  ['kettlebell-swing', '壶铃摆动'],
  ['kettlebell-clean', '壶铃翻举'],
  ['landmine-press', '地雷管推举'],
  ['landmine-row', '地雷管划船'],
  ['turkish-get-up', '土耳其起立'],
  ['dumbbell-thruster', '哑铃深蹲推举'],
  ['wall-sit', '靠墙静蹲'],
  ['nordic-hamstring-curl', '北欧腿弯举'],
  ['band-pull-apart', '弹力带拉开']
] as const;

describe('exercise catalog v1', () => {
  it('publishes the exact versioned 80-exercise identity set', async () => {
    const { catalog } = await catalogModule();
    expect(catalog).toMatchObject({
      datasetVersion: 'exercise-catalog-v1',
      sourceId: 'INTERNAL-EXERCISE-CATALOG-V1',
      reviewedAt: '2026-08-10'
    });
    expect(catalog.exercises.map(({ id, nameZh }) => [id, nameZh])).toEqual(EXPECTED_EXERCISES);
    expect(new Set(catalog.exercises.map(({ id }) => id))).toHaveLength(80);
  });

  it('keeps every entry complete, qualitative, and free of exercise-level MET data', async () => {
    const { catalog } = await catalogModule();
    for (const exercise of catalog.exercises) {
      expect(exercise.aliases.length).toBeGreaterThan(0);
      expect(exercise.movementPattern).not.toBe('');
      expect(exercise.primaryMuscles.length).toBeGreaterThan(0);
      expect(exercise.secondaryMuscles.length).toBeGreaterThan(0);
      expect(exercise.equipment.length).toBeGreaterThan(0);
      expect(exercise.steps.length).toBeGreaterThanOrEqual(2);
      expect(exercise.commonErrors.length).toBeGreaterThan(0);
      expect(exercise.caution).not.toBe('');
      expect(exercise.supportedSessionIntensities.length).toBeGreaterThan(0);
      expect(exercise).not.toHaveProperty('met');
      expect(exercise).not.toHaveProperty('sessionCode');
      expect(exercise).not.toHaveProperty('image');
      expect(exercise).not.toHaveProperty('video');
    }
  });

  it('finds only reviewed identifiers', async () => {
    const { catalog, findExerciseById, isReviewedExerciseId } = await catalogModule();
    expect(findExerciseById('back-squat')).toEqual(catalog.exercises[0]);
    expect(findExerciseById('unknown-exercise')).toBeUndefined();
    expect(isReviewedExerciseId('back-squat')).toBe(true);
    expect(isReviewedExerciseId('unknown-exercise')).toBe(false);
  });

  it('keeps distinct defining instructions for dead bug, bird dog, and hollow hold', async () => {
    const { findExerciseById } = await catalogModule();
    const deadBug = findExerciseById('dead-bug');
    const birdDog = findExerciseById('bird-dog');
    const hollowHold = findExerciseById('hollow-hold');
    expect(deadBug?.steps.join('')).toContain('仰卧');
    expect(deadBug?.steps.join('')).toContain('对侧手臂和腿');
    expect(birdDog?.steps.join('')).toContain('四点跪姿');
    expect(hollowHold?.steps.join('')).toContain('腰部贴地');
    expect(hollowHold?.steps.join('')).toContain('肩胛和双腿离开地面');
  });
});
