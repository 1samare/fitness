export type ExerciseDifficulty = 'beginner' | 'intermediate' | 'advanced';
export type SupportedSessionIntensity = 'moderate' | 'vigorous';

export interface ExerciseDefinition {
  readonly id: string;
  readonly nameZh: string;
  readonly aliases: readonly string[];
  readonly movementPattern: string;
  readonly primaryMuscles: readonly string[];
  readonly secondaryMuscles: readonly string[];
  readonly equipment: readonly string[];
  readonly difficulty: ExerciseDifficulty;
  readonly steps: readonly string[];
  readonly commonErrors: readonly string[];
  readonly caution: string;
  readonly supportedSessionIntensities: readonly SupportedSessionIntensity[];
}

interface ExerciseGuidance {
  readonly steps: readonly [string, string];
  readonly commonError: string;
}

type GuidanceKey = keyof typeof GUIDANCE;

type ExerciseSeed = readonly [
  id: string,
  nameZh: string,
  movementPattern: string,
  primaryMuscles: readonly string[],
  secondaryMuscles: readonly string[],
  equipment: readonly string[],
  difficulty: ExerciseDifficulty,
  guidance: GuidanceKey,
  supportedSessionIntensities: readonly SupportedSessionIntensity[]
];

const BOTH_INTENSITIES = ['moderate', 'vigorous'] as const;
const MODERATE_ONLY = ['moderate'] as const;

const GUIDANCE = {
  squat: { steps: ['双脚稳定站立，躯干保持自然中立。', '屈髋屈膝下蹲，再由全脚掌发力站起。'], commonError: '膝盖方向与脚尖不一致或脚跟离地。' },
  splitSquat: { steps: ['前后脚稳定分开，躯干保持直立。', '垂直下降至可控深度，再以前脚发力起身。'], commonError: '前膝内扣或重心大幅前后晃动。' },
  lunge: { steps: ['站稳并收紧躯干，向指定方向迈步。', '双膝屈曲下降后，通过支撑脚回到稳定站姿。'], commonError: '步幅失控导致膝盖内扣或身体倾斜。' },
  step: { steps: ['将整只支撑脚放稳在台面上。', '用台面侧腿发力登上，再受控返回。'], commonError: '用后脚蹬地借力或落下时失去控制。' },
  machineSquat: { steps: ['按器械说明调整座位和脚位并贴稳身体。', '在可控范围屈膝下降，再平稳推回。'], commonError: '锁死膝关节或让髋部离开靠垫。' },
  kneeExtension: { steps: ['调整转轴与膝关节对齐并固定躯干。', '伸膝至可控位置，再缓慢屈膝返回。'], commonError: '甩动小腿或借助躯干惯性。' },
  kneeCurl: { steps: ['调整器械使膝关节与转轴对齐。', '屈膝收紧腿后侧，再缓慢伸膝返回。'], commonError: '抬起髋部或用快速弹动完成动作。' },
  hinge: { steps: ['双脚站稳，保持脊柱自然中立。', '髋部向后移动后伸髋站起，器械贴近身体。'], commonError: '以弯腰代替屈髋或负重远离身体。' },
  singleLegHinge: { steps: ['单脚稳定支撑，另一腿自然向后延伸。', '髋部后移至可控位置，再收髋回到站姿。'], commonError: '骨盆向一侧翻转或支撑膝内扣。' },
  hipExtension: { steps: ['稳住双脚与躯干，建立髋部起始位置。', '收紧臀部完成伸髋，再受控回落。'], commonError: '过度挺腰代替髋关节伸展。' },
  calfRaise: { steps: ['前脚掌稳定承重，保持膝盖方向固定。', '抬起脚跟至可控高度，再缓慢下降。'], commonError: '脚踝向内外偏移或快速弹动。' },
  horizontalPress: { steps: ['固定肩胛与支撑点，握具位于胸部两侧。', '平稳推起至手臂接近伸直，再受控下放。'], commonError: '肩部前移或肘部过度外展。' },
  pushUp: { steps: ['双手撑地并让头、躯干和腿保持一线。', '屈肘下降至可控深度，再推回起始位置。'], commonError: '塌腰、耸肩或头部先行。' },
  dip: { steps: ['双手稳定支撑，肩胛保持可控。', '屈肘下降至舒适深度，再推起身体。'], commonError: '肩部过度前移或下降过深。' },
  fly: { steps: ['保持肘部微屈并稳定肩胛。', '沿弧线合拢双臂，再受控打开。'], commonError: '用屈伸肘代替肩关节水平内收。' },
  verticalPress: { steps: ['稳定躯干，将负重置于肩部附近。', '向上推举至手臂接近伸直，再受控下降。'], commonError: '过度后仰或耸肩完成推举。' },
  shoulderRaise: { steps: ['保持躯干稳定，手臂自然微屈。', '抬臂至可控高度，再缓慢返回。'], commonError: '摆动躯干或用耸肩代偿。' },
  rearShoulder: { steps: ['固定躯干并让肩胛保持自然位置。', '向外拉开手臂并短暂停顿，再受控返回。'], commonError: '过度耸肩或用腰背摆动。' },
  uprightPull: { steps: ['双手握具垂于身体前方，躯干稳定。', '沿身体向上提拉至舒适高度，再缓慢下降。'], commonError: '手肘抬得过高或借助身体摆动。' },
  verticalPull: { steps: ['稳定躯干并握紧横杆或把手。', '向下拉动或拉起身体，再受控返回。'], commonError: '耸肩、摆腿或过度后仰借力。' },
  row: { steps: ['固定躯干并保持肩部远离耳朵。', '将负重拉向躯干，再受控伸臂返回。'], commonError: '含胸耸肩或用腰部摆动借力。' },
  straightArmPull: { steps: ['保持肘部角度稳定并收紧躯干。', '以肩关节带动手臂向身体靠近，再受控返回。'], commonError: '用屈肘或挺腰代替肩关节动作。' },
  shrug: { steps: ['双手持重并保持躯干直立。', '肩膀垂直上提后短暂停顿，再缓慢下降。'], commonError: '转动肩关节或用膝髋弹动借力。' },
  curl: { steps: ['上臂贴近躯干并稳定手腕。', '屈肘举起负重，再缓慢伸肘返回。'], commonError: '上臂前移或摆动身体借力。' },
  triceps: { steps: ['固定上臂与躯干，保持手腕中立。', '伸直手肘后短暂停顿，再受控屈肘。'], commonError: '上臂大幅移动或腰部代偿。' },
  plank: { steps: ['以前臂或双手建立稳定支撑。', '收紧躯干并维持头、躯干和腿的稳定排列。'], commonError: '塌腰、抬髋或憋气。' },
  sidePlank: { steps: ['以单侧前臂和脚建立稳定支撑。', '抬起髋部并保持身体侧面成一线。'], commonError: '髋部下沉或身体向前后旋转。' },
  deadBug: { steps: ['仰卧，双臂朝上并让髋膝屈曲约成直角。', '保持腰部贴地，缓慢伸展对侧手臂和腿后返回。'], commonError: '腰部离地或手臂和腿下落过快。' },
  birdDog: { steps: ['四点跪姿，双手位于肩下、双膝位于髋下。', '保持躯干稳定，伸展对侧手臂和腿后受控返回。'], commonError: '骨盆转动或抬起的手臂和腿过高。' },
  hollowHold: { steps: ['仰卧并将腰部贴地，双臂置于身体上方。', '抬起肩胛和双腿离开地面，在可控幅度保持姿势。'], commonError: '腰部离地或抬头过度。' },
  trunkFlexion: { steps: ['固定支撑点并收紧躯干。', '以腹部控制骨盆或躯干卷起，再缓慢返回。'], commonError: '用摆动或髋屈肌惯性完成动作。' },
  rollout: { steps: ['跪姿握稳器械并先收紧躯干。', '缓慢向前滚动至可控范围，再拉回起始位置。'], commonError: '腰部塌陷或前伸距离超过控制能力。' },
  antiRotation: { steps: ['侧对阻力源站稳，将把手置于胸前。', '向前伸臂并抵抗躯干旋转，再收回。'], commonError: '身体随阻力转动或重心偏移。' },
  carry: { steps: ['稳定提起负重并保持躯干直立。', '以均匀步幅行走，结束时受控放下。'], commonError: '耸肩、侧倾或步幅失去控制。' },
  kettlebellSwing: { steps: ['双手握壶铃并以髋部后移蓄力。', '快速伸髋带动壶铃摆起，再受控回摆。'], commonError: '用手臂抬举或以下蹲代替髋铰链。' },
  kettlebellClean: { steps: ['单手握壶铃并以髋部后移蓄力。', '伸髋引导壶铃贴近身体进入架式位。'], commonError: '壶铃绕行过远并撞击前臂。' },
  getUp: { steps: ['仰卧稳定持重，按顺序建立手肘、手掌和脚支撑。', '保持负重稳定逐步站起，再沿原路径返回。'], commonError: '跳过支撑步骤或让负重偏离稳定垂线。' },
  compound: { steps: ['稳定持重并完成可控下蹲。', '站起时连贯向上推举，再受控回到起始位。'], commonError: '下蹲与推举脱节或腰部过度后仰。' },
  wallSit: { steps: ['背部贴墙并将双脚置于稳定位置。', '屈膝下降至可控角度并保持均匀呼吸。'], commonError: '膝盖内扣或脚跟离地。' },
  nordicCurl: { steps: ['固定脚踝并以跪姿保持髋部伸展。', '缓慢向前降低躯干，并用手支撑安全返回。'], commonError: '髋部先弯曲或下降速度失控。' }
} as const satisfies Record<string, ExerciseGuidance>;

const EXERCISE_SEEDS: readonly ExerciseSeed[] = [
  ['back-squat', '深蹲', '双侧蹲', ['股四头肌', '臀大肌'], ['腘绳肌', '核心稳定肌群'], ['杠铃', '深蹲架'], 'intermediate', 'squat', BOTH_INTENSITIES],
  ['front-squat', '前蹲', '双侧蹲', ['股四头肌'], ['臀大肌', '上背部'], ['杠铃', '深蹲架'], 'advanced', 'squat', BOTH_INTENSITIES],
  ['goblet-squat', '高脚杯深蹲', '双侧蹲', ['股四头肌', '臀大肌'], ['核心稳定肌群'], ['哑铃或壶铃'], 'beginner', 'squat', BOTH_INTENSITIES],
  ['split-squat', '分腿蹲', '分腿蹲', ['股四头肌', '臀大肌'], ['腘绳肌', '核心稳定肌群'], ['自重或哑铃'], 'beginner', 'splitSquat', BOTH_INTENSITIES],
  ['bulgarian-split-squat', '保加利亚分腿蹲', '分腿蹲', ['股四头肌', '臀大肌'], ['腘绳肌', '核心稳定肌群'], ['训练凳', '哑铃'], 'intermediate', 'splitSquat', BOTH_INTENSITIES],
  ['reverse-lunge', '后撤箭步蹲', '箭步蹲', ['股四头肌', '臀大肌'], ['腘绳肌', '小腿肌群'], ['自重或哑铃'], 'beginner', 'lunge', BOTH_INTENSITIES],
  ['walking-lunge', '行走箭步蹲', '箭步蹲', ['股四头肌', '臀大肌'], ['腘绳肌', '小腿肌群'], ['自重或哑铃'], 'intermediate', 'lunge', BOTH_INTENSITIES],
  ['lateral-lunge', '侧向箭步蹲', '侧向蹲', ['臀大肌', '股四头肌'], ['内收肌群', '核心稳定肌群'], ['自重或哑铃'], 'intermediate', 'lunge', BOTH_INTENSITIES],
  ['step-up', '登阶', '单腿登阶', ['股四头肌', '臀大肌'], ['腘绳肌', '小腿肌群'], ['训练箱或台阶'], 'beginner', 'step', BOTH_INTENSITIES],
  ['leg-press', '腿举', '器械蹲推', ['股四头肌', '臀大肌'], ['腘绳肌'], ['腿举机'], 'beginner', 'machineSquat', BOTH_INTENSITIES],
  ['hack-squat', '哈克深蹲', '器械蹲', ['股四头肌'], ['臀大肌', '腘绳肌'], ['哈克深蹲机'], 'intermediate', 'machineSquat', BOTH_INTENSITIES],
  ['leg-extension', '腿屈伸', '膝关节伸展', ['股四头肌'], ['核心稳定肌群'], ['腿屈伸机'], 'beginner', 'kneeExtension', MODERATE_ONLY],
  ['lying-leg-curl', '俯卧腿弯举', '膝关节屈曲', ['腘绳肌'], ['腓肠肌'], ['俯卧腿弯举机'], 'beginner', 'kneeCurl', MODERATE_ONLY],
  ['seated-leg-curl', '坐姿腿弯举', '膝关节屈曲', ['腘绳肌'], ['腓肠肌'], ['坐姿腿弯举机'], 'beginner', 'kneeCurl', MODERATE_ONLY],
  ['conventional-deadlift', '传统硬拉', '髋铰链', ['臀大肌', '腘绳肌'], ['竖脊肌', '背部肌群'], ['杠铃'], 'advanced', 'hinge', BOTH_INTENSITIES],
  ['sumo-deadlift', '相扑硬拉', '宽站距髋铰链', ['臀大肌', '内收肌群'], ['股四头肌', '背部肌群'], ['杠铃'], 'advanced', 'hinge', BOTH_INTENSITIES],
  ['romanian-deadlift', '罗马尼亚硬拉', '髋铰链', ['腘绳肌', '臀大肌'], ['竖脊肌', '背部肌群'], ['杠铃或哑铃'], 'intermediate', 'hinge', BOTH_INTENSITIES],
  ['single-leg-rdl', '单腿罗马尼亚硬拉', '单腿髋铰链', ['腘绳肌', '臀大肌'], ['核心稳定肌群', '足踝稳定肌群'], ['自重或哑铃'], 'intermediate', 'singleLegHinge', BOTH_INTENSITIES],
  ['good-morning', '早安式', '髋铰链', ['腘绳肌', '臀大肌'], ['竖脊肌'], ['杠铃'], 'advanced', 'hinge', MODERATE_ONLY],
  ['hip-thrust', '臀推', '髋关节伸展', ['臀大肌'], ['腘绳肌', '核心稳定肌群'], ['训练凳', '杠铃'], 'intermediate', 'hipExtension', BOTH_INTENSITIES],
  ['glute-bridge', '臀桥', '髋关节伸展', ['臀大肌'], ['腘绳肌', '核心稳定肌群'], ['自重或弹力带'], 'beginner', 'hipExtension', MODERATE_ONLY],
  ['standing-calf-raise', '站姿提踵', '踝关节跖屈', ['腓肠肌'], ['比目鱼肌', '足底肌群'], ['自重或提踵机'], 'beginner', 'calfRaise', BOTH_INTENSITIES],
  ['seated-calf-raise', '坐姿提踵', '踝关节跖屈', ['比目鱼肌'], ['腓肠肌', '足底肌群'], ['坐姿提踵机'], 'beginner', 'calfRaise', MODERATE_ONLY],
  ['barbell-bench-press', '杠铃卧推', '水平推', ['胸大肌'], ['肱三头肌', '三角肌前束'], ['杠铃', '卧推凳'], 'intermediate', 'horizontalPress', BOTH_INTENSITIES],
  ['dumbbell-bench-press', '哑铃卧推', '水平推', ['胸大肌'], ['肱三头肌', '三角肌前束'], ['哑铃', '卧推凳'], 'intermediate', 'horizontalPress', BOTH_INTENSITIES],
  ['incline-bench-press', '上斜卧推', '上斜水平推', ['胸大肌上部'], ['肱三头肌', '三角肌前束'], ['杠铃或哑铃', '上斜凳'], 'intermediate', 'horizontalPress', BOTH_INTENSITIES],
  ['decline-bench-press', '下斜卧推', '下斜水平推', ['胸大肌'], ['肱三头肌', '三角肌前束'], ['杠铃或哑铃', '下斜凳'], 'advanced', 'horizontalPress', BOTH_INTENSITIES],
  ['push-up', '俯卧撑', '水平推', ['胸大肌'], ['肱三头肌', '核心稳定肌群'], ['自重'], 'beginner', 'pushUp', BOTH_INTENSITIES],
  ['parallel-bar-dip', '双杠臂屈伸', '垂直支撑推', ['胸大肌', '肱三头肌'], ['三角肌前束'], ['双杠'], 'advanced', 'dip', BOTH_INTENSITIES],
  ['chest-fly', '胸飞鸟', '肩关节水平内收', ['胸大肌'], ['三角肌前束'], ['哑铃或飞鸟机'], 'beginner', 'fly', MODERATE_ONLY],
  ['cable-crossover', '绳索夹胸', '肩关节水平内收', ['胸大肌'], ['三角肌前束', '核心稳定肌群'], ['绳索器械'], 'intermediate', 'fly', MODERATE_ONLY],
  ['barbell-overhead-press', '杠铃推举', '垂直推', ['三角肌'], ['肱三头肌', '核心稳定肌群'], ['杠铃'], 'advanced', 'verticalPress', BOTH_INTENSITIES],
  ['dumbbell-shoulder-press', '哑铃肩推', '垂直推', ['三角肌'], ['肱三头肌', '核心稳定肌群'], ['哑铃'], 'intermediate', 'verticalPress', BOTH_INTENSITIES],
  ['arnold-press', '阿诺德推举', '旋转垂直推', ['三角肌'], ['肱三头肌', '核心稳定肌群'], ['哑铃'], 'intermediate', 'verticalPress', BOTH_INTENSITIES],
  ['lateral-raise', '侧平举', '肩关节外展', ['三角肌中束'], ['斜方肌'], ['哑铃或绳索'], 'beginner', 'shoulderRaise', MODERATE_ONLY],
  ['front-raise', '前平举', '肩关节屈曲', ['三角肌前束'], ['胸大肌上部'], ['哑铃或杠铃片'], 'beginner', 'shoulderRaise', MODERATE_ONLY],
  ['reverse-fly', '反向飞鸟', '肩关节水平外展', ['三角肌后束'], ['菱形肌', '斜方肌'], ['哑铃或飞鸟机'], 'beginner', 'rearShoulder', MODERATE_ONLY],
  ['face-pull', '面拉', '肩关节水平外展与外旋', ['三角肌后束'], ['菱形肌', '肩袖肌群'], ['绳索器械'], 'beginner', 'rearShoulder', MODERATE_ONLY],
  ['upright-row', '直立划船', '垂直提拉', ['三角肌', '斜方肌'], ['肱二头肌'], ['杠铃或哑铃'], 'intermediate', 'uprightPull', MODERATE_ONLY],
  ['pull-up', '引体向上', '垂直拉', ['背阔肌'], ['肱二头肌', '菱形肌'], ['单杠'], 'advanced', 'verticalPull', BOTH_INTENSITIES],
  ['chin-up', '反手引体向上', '垂直拉', ['背阔肌', '肱二头肌'], ['菱形肌', '核心稳定肌群'], ['单杠'], 'advanced', 'verticalPull', BOTH_INTENSITIES],
  ['lat-pulldown', '高位下拉', '垂直拉', ['背阔肌'], ['肱二头肌', '菱形肌'], ['高位下拉机'], 'beginner', 'verticalPull', BOTH_INTENSITIES],
  ['seated-cable-row', '坐姿划船', '水平拉', ['背阔肌', '菱形肌'], ['肱二头肌', '三角肌后束'], ['绳索器械'], 'beginner', 'row', BOTH_INTENSITIES],
  ['barbell-row', '杠铃划船', '水平拉', ['背阔肌', '菱形肌'], ['肱二头肌', '竖脊肌'], ['杠铃'], 'advanced', 'row', BOTH_INTENSITIES],
  ['one-arm-dumbbell-row', '单臂哑铃划船', '单侧水平拉', ['背阔肌'], ['菱形肌', '肱二头肌'], ['哑铃', '训练凳'], 'intermediate', 'row', BOTH_INTENSITIES],
  ['chest-supported-row', '胸托划船', '水平拉', ['背阔肌', '菱形肌'], ['肱二头肌', '三角肌后束'], ['哑铃或器械', '上斜凳'], 'beginner', 'row', BOTH_INTENSITIES],
  ['inverted-row', '反向划船', '水平拉', ['背阔肌', '菱形肌'], ['肱二头肌', '核心稳定肌群'], ['低杠或悬吊带'], 'intermediate', 'row', BOTH_INTENSITIES],
  ['straight-arm-pulldown', '直臂下压', '肩关节伸展', ['背阔肌'], ['大圆肌', '核心稳定肌群'], ['绳索器械'], 'beginner', 'straightArmPull', MODERATE_ONLY],
  ['dumbbell-pullover', '哑铃上拉', '肩关节伸展', ['背阔肌', '胸大肌'], ['肱三头肌', '核心稳定肌群'], ['哑铃', '训练凳'], 'intermediate', 'straightArmPull', MODERATE_ONLY],
  ['barbell-shrug', '杠铃耸肩', '肩胛上提', ['斜方肌'], ['前臂肌群'], ['杠铃'], 'beginner', 'shrug', BOTH_INTENSITIES],
  ['barbell-curl', '杠铃弯举', '肘关节屈曲', ['肱二头肌'], ['肱肌', '前臂肌群'], ['杠铃'], 'beginner', 'curl', MODERATE_ONLY],
  ['dumbbell-curl', '哑铃弯举', '肘关节屈曲', ['肱二头肌'], ['肱肌', '前臂肌群'], ['哑铃'], 'beginner', 'curl', MODERATE_ONLY],
  ['hammer-curl', '锤式弯举', '中立握肘屈曲', ['肱肌', '肱桡肌'], ['肱二头肌'], ['哑铃'], 'beginner', 'curl', MODERATE_ONLY],
  ['incline-dumbbell-curl', '上斜哑铃弯举', '肘关节屈曲', ['肱二头肌'], ['肱肌', '前臂肌群'], ['哑铃', '上斜凳'], 'intermediate', 'curl', MODERATE_ONLY],
  ['preacher-curl', '牧师凳弯举', '支撑肘屈曲', ['肱二头肌'], ['肱肌', '前臂肌群'], ['牧师凳', '杠铃或哑铃'], 'beginner', 'curl', MODERATE_ONLY],
  ['triceps-pushdown', '肱三头肌下压', '肘关节伸展', ['肱三头肌'], ['前臂肌群'], ['绳索器械'], 'beginner', 'triceps', MODERATE_ONLY],
  ['overhead-triceps-extension', '过顶臂屈伸', '过顶肘伸展', ['肱三头肌'], ['核心稳定肌群'], ['哑铃或绳索'], 'intermediate', 'triceps', MODERATE_ONLY],
  ['skull-crusher', '仰卧臂屈伸', '仰卧肘伸展', ['肱三头肌'], ['前臂肌群'], ['杠铃或哑铃', '训练凳'], 'intermediate', 'triceps', MODERATE_ONLY],
  ['close-grip-bench-press', '窄握卧推', '窄距水平推', ['肱三头肌'], ['胸大肌', '三角肌前束'], ['杠铃', '卧推凳'], 'advanced', 'horizontalPress', BOTH_INTENSITIES],
  ['plank', '平板支撑', '抗伸展稳定', ['腹横肌', '腹直肌'], ['臀肌', '肩胛稳定肌群'], ['自重'], 'beginner', 'plank', MODERATE_ONLY],
  ['side-plank', '侧平板支撑', '抗侧屈稳定', ['腹斜肌'], ['臀中肌', '肩胛稳定肌群'], ['自重'], 'intermediate', 'sidePlank', MODERATE_ONLY],
  ['dead-bug', '死虫式', '对侧核心控制', ['腹横肌', '腹直肌'], ['髋屈肌', '肩胛稳定肌群'], ['自重'], 'beginner', 'deadBug', MODERATE_ONLY],
  ['bird-dog', '鸟狗式', '对侧核心控制', ['竖脊肌', '腹横肌'], ['臀大肌', '肩胛稳定肌群'], ['自重'], 'beginner', 'birdDog', MODERATE_ONLY],
  ['hollow-hold', '中空支撑', '抗伸展稳定', ['腹直肌', '腹横肌'], ['髋屈肌'], ['自重'], 'intermediate', 'hollowHold', MODERATE_ONLY],
  ['hanging-knee-raise', '悬垂举膝', '躯干与髋屈曲', ['腹直肌'], ['髋屈肌', '前臂肌群'], ['单杠'], 'intermediate', 'trunkFlexion', MODERATE_ONLY],
  ['reverse-crunch', '反向卷腹', '躯干屈曲', ['腹直肌'], ['腹斜肌', '髋屈肌'], ['训练垫'], 'beginner', 'trunkFlexion', MODERATE_ONLY],
  ['ab-wheel-rollout', '健腹轮', '抗伸展控制', ['腹直肌', '腹横肌'], ['背阔肌', '肩胛稳定肌群'], ['健腹轮'], 'advanced', 'rollout', MODERATE_ONLY],
  ['pallof-press', '帕洛夫抗旋推', '抗旋转稳定', ['腹斜肌', '腹横肌'], ['臀肌', '肩胛稳定肌群'], ['绳索或弹力带'], 'beginner', 'antiRotation', MODERATE_ONLY],
  ['farmer-carry', '农夫行走', '双侧负重行走', ['前臂肌群', '斜方肌'], ['核心稳定肌群', '臀肌'], ['哑铃或壶铃'], 'beginner', 'carry', BOTH_INTENSITIES],
  ['suitcase-carry', '单侧提重行走', '单侧负重行走', ['腹斜肌', '前臂肌群'], ['斜方肌', '臀中肌'], ['哑铃或壶铃'], 'intermediate', 'carry', BOTH_INTENSITIES],
  ['kettlebell-deadlift', '壶铃硬拉', '髋铰链', ['臀大肌', '腘绳肌'], ['股四头肌', '背部肌群'], ['壶铃'], 'beginner', 'hinge', BOTH_INTENSITIES],
  ['kettlebell-swing', '壶铃摆动', '爆发髋铰链', ['臀大肌', '腘绳肌'], ['背部肌群', '核心稳定肌群'], ['壶铃'], 'advanced', 'kettlebellSwing', BOTH_INTENSITIES],
  ['kettlebell-clean', '壶铃翻举', '爆发髋铰链与提拉', ['臀大肌', '腘绳肌'], ['三角肌', '前臂肌群'], ['壶铃'], 'advanced', 'kettlebellClean', BOTH_INTENSITIES],
  ['landmine-press', '地雷管推举', '斜向推', ['三角肌', '胸大肌上部'], ['肱三头肌', '核心稳定肌群'], ['地雷管装置', '杠铃'], 'intermediate', 'verticalPress', BOTH_INTENSITIES],
  ['landmine-row', '地雷管划船', '水平拉', ['背阔肌', '菱形肌'], ['肱二头肌', '竖脊肌'], ['地雷管装置', '杠铃'], 'intermediate', 'row', BOTH_INTENSITIES],
  ['turkish-get-up', '土耳其起立', '多平面起立', ['核心稳定肌群', '肩胛稳定肌群'], ['臀肌', '股四头肌'], ['壶铃或哑铃'], 'advanced', 'getUp', MODERATE_ONLY],
  ['dumbbell-thruster', '哑铃深蹲推举', '蹲与垂直推', ['股四头肌', '三角肌'], ['臀大肌', '肱三头肌'], ['哑铃'], 'advanced', 'compound', BOTH_INTENSITIES],
  ['wall-sit', '靠墙静蹲', '等长蹲', ['股四头肌'], ['臀大肌', '小腿肌群'], ['墙面'], 'beginner', 'wallSit', MODERATE_ONLY],
  ['nordic-hamstring-curl', '北欧腿弯举', '离心膝屈曲控制', ['腘绳肌'], ['臀肌', '核心稳定肌群'], ['脚踝固定点', '训练垫'], 'advanced', 'nordicCurl', MODERATE_ONLY],
  ['band-pull-apart', '弹力带拉开', '肩关节水平外展', ['三角肌后束', '菱形肌'], ['斜方肌', '肩袖肌群'], ['弹力带'], 'beginner', 'rearShoulder', MODERATE_ONLY]
];

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function createExercise(seed: ExerciseSeed): ExerciseDefinition {
  const [
    id,
    nameZh,
    movementPattern,
    primaryMuscles,
    secondaryMuscles,
    equipment,
    difficulty,
    guidanceKey,
    supportedSessionIntensities
  ] = seed;
  const guidance = GUIDANCE[guidanceKey];

  return Object.freeze({
    id,
    nameZh,
    aliases: freezeStrings([id.replaceAll('-', ' ')]),
    movementPattern,
    primaryMuscles: freezeStrings(primaryMuscles),
    secondaryMuscles: freezeStrings(secondaryMuscles),
    equipment: freezeStrings(equipment),
    difficulty,
    steps: freezeStrings(guidance.steps),
    commonErrors: freezeStrings([guidance.commonError]),
    caution: '从可控负荷和幅度开始；无法保持稳定动作时结束本组。',
    supportedSessionIntensities: Object.freeze([...supportedSessionIntensities])
  });
}

const exercises = Object.freeze(EXERCISE_SEEDS.map(createExercise));
const exercisesById = new Map(exercises.map((exercise) => [exercise.id, exercise]));

export const EXERCISE_CATALOG_V1 = Object.freeze({
  datasetVersion: 'exercise-catalog-v1' as const,
  sourceId: 'INTERNAL-EXERCISE-CATALOG-V1' as const,
  reviewedAt: '2026-08-10' as const,
  exercises
});

export function findExerciseById(id: string): ExerciseDefinition | undefined {
  return exercisesById.get(id);
}

export function isReviewedExerciseId(id: string): boolean {
  return exercisesById.has(id);
}
