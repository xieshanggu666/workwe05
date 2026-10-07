"use strict";
/* 家庭分餐协作：
   1. 按全家成员营养目标（RNI 热量）生成基底周菜单（复用 menu.weekPlan），
      再按各成员热量占比把每道菜分摊为成员份量（毛重克），逐人计算营养目标达标度；
   2. 三阶段确认流水线：家长确认份量（可微调克重）→ 成员确认替换（同类食材替换并留痕）
      → 采购负责人确认到货；阶段顺序强制，前一阶段未完成不能进入下一阶段；
   3. 每次份量 / 替换变动即时重算净采购需求并同步采购清单（库存与待买抵扣）、预算、
      过敏限制（全家并集 + 该成员个人过敏原双重拦截）与库存消耗；
   4. 可追溯：份量调整、替换前后食材、确认人 / 时间、按成员入账的消耗全部保留；
   菜单版本与采购周绑定，周期切换后旧菜单仅可追溯不可再入账。 */

const { FOODS, getFood, costFor, nutrientsFor, NUTRIENT_ORDER } = require("./foods");
const { getRequirement } = require("./requirements");
const { weekPlan } = require("./menu");
const { totalOf, purchaseState } = require("./constraints");
const hh = require("./household");

const STAGES = ["portions", "substitutions", "arrivals"];
const STAGE_LABEL = { portions: "份量确认", substitutions: "替换确认", arrivals: "到货确认" };

function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }
function nowIso() { return new Date().toISOString(); }
function errCode(code, msg) { const e = new Error(msg); e.code = code; return e; }

function memberById(state, id) {
  const m = state.members.find(x => x.id === id);
  if (!m) throw errCode("NO_MEMBER", "成员不存在或已删除");
  return m;
}
function assertRole(member, role) {
  if (!hh.hasRole(member, role)) {
    throw errCode("FORBIDDEN_ROLE", `仅${role === "parent" ? "家长" : "采购负责人"}可执行该操作（${member.name} 的角色为${member.roles && member.roles.length ? member.roles.join("、") : "成员"}）`);
  }
}

function currentMealPlan(state) {
  if (!state.meal_plan || !state.meal_plan.plan) throw errCode("NO_MEAL_PLAN", "尚未生成分餐协作菜单");
  return state.meal_plan;
}

/* 基底菜单按系数线性缩放克重，并重算每日营养 / 成本 / 库存结转汇总 */
function scalePlan(plan, k) {
  if (Math.abs(k - 1) < 0.02) return plan;
  const stockLive = {};
  for (const day of plan.days) {
    for (const it of day.items) {
      it.grams = Math.max(0.5, Math.round(it.grams * k * 10) / 10);
      it.cost = round1(costFor(getFood(it.food_id), it.grams));
    }
    const totals = totalOf(day.items);
    day.totals = totals;
    day.cost = totals.cost;
    const stock = day.stock_remaining; // 缩放前逐日结转口径
    /* 重新按缩放后克重做一次库存抵扣（使用上一日结转入参），保持 purchase_cost 口径一致 */
    if (stock) {
      const ps = purchaseState(day.items, stockLive);
      day.purchase_cost = ps.purchase_cost;
      for (const [id, g] of Object.entries(ps.remaining)) stockLive[id] = g;
      day.stock_remaining = { ...stockLive };
    }
  }
  const sumCost = plan.days.reduce((s, d) => s + d.cost, 0);
  const sumPurchase = plan.days.reduce((s, d) => s + (d.purchase_cost || 0), 0);
  plan.weekly_cost = round1(sumCost);
  plan.weekly_purchase_cost = round1(sumPurchase);
  plan.energy_scale = round2(k);
  return plan;
}

/* ---------------- 生成菜单与分餐 ---------------- */

/* 成员营养目标（热量为分摊基准，其余为逐人达标度目标） */
function memberTargets(members) {
  return members.map(m => {
    const req = getRequirement(m.profile);
    return { member_id: m.id, name: m.name, kcal: req.kcal, requirement: req };
  });
}

/* 生成基底菜单：以全家总热量目标的人均值为画像热量基准（采用第一位成员的画像分层，
   再用 total_energy 缩放），由 weekPlan 输出菜品构成，最后按成员热量占比分摊。 */
function buildMealPlan(state, opts) {
  opts = opts || {};
  if (!state.members.length) throw errCode("NO_MEMBER", "请先添加家庭成员");
  if (!state.members.some(m => hh.hasRole(m, "parent"))) throw errCode("NO_PARENT", "至少需要一名家长角色成员");
  if (!state.members.some(m => hh.hasRole(m, "buyer"))) throw errCode("NO_BUYER", "至少需要一名采购负责人角色成员");

  const members = state.members;
  const targets = memberTargets(members);
  const totalKcal = targets.reduce((s, t) => s + t.kcal, 0);

  /* 基底画像：取成员中热量目标中位数对应成员，保证菜品构成贴近全家 */
  const ordered = [...targets].sort((a, b) => a.kcal - b.kcal);
  const anchor = members.find(m => m.id === ordered[Math.floor(ordered.length / 2)].member_id);
  const baseReq = getRequirement(anchor.profile);
  /* 基底人均热量 = 全家总热量 / 人数；缩放系数作用于 anchor 画像 */
  const perKcal = totalKcal / members.length;
  const kScale = perKcal / baseReq.kcal;

  const sync = hh.syncInputs(state);
  const params = {
    profile: anchor.profile,
    energy_scale: opts.energy_scale != null ? Number(opts.energy_scale) : kScale,
    /* 基底菜单的日预算：周预算 / 7（家庭总量由分餐克重体现，预算约束仅用于菜品替换求解） */
    budget: opts.daily_budget != null ? Number(opts.daily_budget) : Math.max(1, (Number(state.weekly_budget) || 0) / 7),
    allergens: hh.familyAllergens(members),
    exclude: opts.exclude || [],
    stock: sync.stock,
    weekly_used: sync.weekly_used,
  };

  const plan = weekPlan(params);

  /* weekPlan 输出 anchor 人均口径（每日热量贴近 anchor 目标），按全家目标人均 / anchor 目标
     线性缩放克重，使基底菜单的每日热量贴近全家目标人均；营养素随之线性变化并重算汇总。
     库存抵扣采购额按同口径缩放（采购清单最终以分餐净需求重建，此处仅展示口径）。 */
  scalePlan(plan, kScale);

  const mp = {
    cycle: state.cycle_no,
    created_at: nowIso(),
    params,
    plan,                       // 基底周菜单（anchor 人均口径）
    anchor_member_id: anchor.id,
    total_kcal: totalKcal,
    base_kcal: Math.round(perKcal),
    members: members.map(m => ({
      member_id: m.id,
      name: m.name,
      roles: [...(m.roles || [])],
      allergens: [...(m.allergens || [])],
      target_kcal: getRequirement(m.profile).kcal,
      share: round2(getRequirement(m.profile).kcal / perKcal), // 相对基底人均的份量系数
      portion_confirmed: false,
      portion_confirmed_at: null,
    })),
    dishes: [],                 // 分餐菜品（含每个成员克重、替换记录）
    stage: "portions",
    consumed_days: [],
    next_dish_id: 1,
    audit: [{ at: nowIso(), actor: null, action: "create", text: `按 ${members.length} 位成员营养目标生成分餐菜单（全家目标 ${totalKcal} kcal/日）` }],
  };

  sliceDishes(mp, plan, members);
  state.meal_plan = mp;
  return mp;
}

/* 把基底菜单按成员份额系数拆为分餐菜品：
   基底一道菜的克重是 anchor 人均口径，成员 i 的克重 = 基底克重 × share_i（share 以人均为 1）。 */
function sliceDishes(mp, plan, members) {
  mp.dishes = [];
  const reqOf = {};
  for (const m of members) reqOf[m.id] = getRequirement(m.profile);
  const shares = {};
  for (const mi of mp.members) shares[mi.member_id] = mi.share;

  for (const day of plan.days) {
    for (const it of day.items) {
      const portions = {};
      for (const m of members) {
        portions[m.id] = Math.max(1, Math.round(it.grams * (shares[m.id] != null ? shares[m.id] : 1)));
      }
      mp.dishes.push({
        id: mp.next_dish_id++,
        day: day.day,
        meal: it.meal,
        role: it.role,
        food_id: it.food_id,
        portions,                  // {member_id: 克重（毛重）}
        history: [],               // 份量 / 替换留痕
        member_status: {},         // {member_id: {sub:"pending"|"ok"|"replaced", food_id, at, by}}
      });
    }
  }
}

/* ---------------- 有效菜品与采购需求 ---------------- */

/* 每个成员每道菜当前生效的食材（替换后为新食材）与克重 */
function effectivePortion(dish, memberId) {
  const hist = (dish.history || []).filter(h => h.type === "substitute" && h.member_id === memberId);
  const grams = (dish.portions || {})[memberId] || 0;
  if (hist.length) {
    const last = hist[hist.length - 1];
    return { food_id: last.to_food_id, grams: last.to_grams != null ? last.to_grams : grams, replaced: true };
  }
  return { food_id: dish.food_id, grams, replaced: false };
}

/* 全家净采购需求：按当前生效菜品聚合 {food_id: 克重} */
function mealNeeds(mp) {
  const need = {};
  for (const d of mp.dishes) {
    for (const memberId of Object.keys(d.portions || {})) {
      const eff = effectivePortion(d, Number(memberId));
      if (eff.grams > 0) need[eff.food_id] = (need[eff.food_id] || 0) + eff.grams;
    }
  }
  return need;
}

/* ---------------- 阶段守卫 ---------------- */

function assertStage(mp, stage) {
  if (mp.stage !== stage) {
    throw errCode("STAGE_LOCKED", `当前处于「${STAGE_LABEL[mp.stage]}」阶段，请先完成「${STAGE_LABEL[stage]}」`);
  }
}

function portionsReady(mp) {
  return mp.members.length > 0 && mp.members.every(m => m.portion_confirmed);
}
function substitutionsReady(mp) {
  /* 每道菜每位成员的替换都已处理（确认接受或已替换）；不含已离开家庭的成员 */
  const ids = new Set(mp.members.map(m => m.member_id));
  for (const d of mp.dishes) {
    for (const id of ids) {
      const st = (d.member_status || {})[id];
      if (!st || st.sub === "pending") return false;
    }
  }
  return true;
}

function advanceStage(mp) {
  if (mp.stage === "portions" && portionsReady(mp)) mp.stage = "substitutions";
  if (mp.stage === "substitutions" && substitutionsReady(mp)) mp.stage = "arrivals";
}

/* ---------------- 家长确认份量 ---------------- */

function confirmPortions(state, actorId, input) {
  const mp = currentMealPlan(state);
  assertCurrentCycle(state, mp);
  assertStage(mp, "portions");
  const actor = memberById(state, actorId);
  assertRole(actor, "parent");

  /* 家长可一次性为某位成员（或全家）微调克重：adjustments: [{dish_id, member_id?, grams}] */
  const adjs = (input && input.adjustments) || [];
  for (const a of adjs) {
    const dish = mp.dishes.find(d => d.id === a.dish_id);
    if (!dish) throw errCode("NO_DISH", "菜品不存在：" + a.dish_id);
    const g = Math.round(Number(a.grams) * 10) / 10;
    if (!(g > 0)) throw errCode("BAD_GRAMS", "份量克重必须为正数");
    const targets = a.member_id != null ? [memberById(state, a.member_id).id] : mp.members.map(m => m.member_id);
    for (const mid of targets) {
      if (dish.portions[mid] == null) throw errCode("NO_MEMBER", "该成员不在本菜单中");
      const from = dish.portions[mid];
      dish.portions[mid] = g;
      dish.history.push({ type: "portion", at: nowIso(), by: actor.id, member_id: mid, from_grams: from, to_grams: g });
    }
  }

  const memberId = input && input.member_id != null ? memberById(state, input.member_id).id : actor.id;
  const mi = mp.members.find(m => m.member_id === memberId);
  if (!mi) throw errCode("NO_MEMBER", "该成员不在本菜单中");
  mi.portion_confirmed = true;
  mi.portion_confirmed_at = nowIso();
  mp.audit.push({ at: nowIso(), actor: actor.id, action: "portion", text: `家长 ${actor.name} 确认了 ${mi.name === actor.name ? "自己的" : mi.name + " 的"}份量` });

  advanceStage(mp);
  syncShopping(state, mp);
  return mp;
}

/* ---------------- 成员确认替换 ---------------- */

/* 候选替换食材：同一餐槽位（pool）内、不含全家并集与该成员个人过敏原、
   非排除项、满足周限次；按同角色、净采购成本（库存优先）排序 */
function substitutionCandidates(state, mp, dish, memberId) {
  const f0 = getFood(effectivePortion(dish, memberId).food_id);
  const avoidFamily = new Set(hh.familyAllergens(state.members));
  const member = state.members.find(m => m.id === memberId);
  const avoidOwn = new Set(member ? member.allergens : []);
  const weeklyUsed = hh.weeklyUsed(state);

  let pool = FOODS.filter(c => {
    if (c.id === f0.id) return false;
    if (c.cat !== f0.cat) return false;
    if (c.allergens.some(a => avoidFamily.has(a) || avoidOwn.has(a))) return false;
    if (mp.params.exclude && mp.params.exclude.includes(c.id)) return false;
    if (c.weekly_limit && (weeklyUsed[c.id] || 0) >= c.weekly_limit) return false;
    /* 蛋白质主菜只在高蛋白食材间替换，避免用蔬菜替换肉 */
    if (dish.role === "protein" && c.per100g.protein < 10) return false;
    return true;
  });
  const stock = hh.stockOnHand(state);
  const grams = (dish.portions || {})[memberId] || 0;
  pool = pool.map(c => ({
    c,
    inStock: (stock[c.id] || 0),
    effCost: costFor(c, Math.max(0, grams - (stock[c.id] || 0))),
  })).sort((a, b) => Number(b.inStock > 0) - Number(a.inStock > 0) || a.effCost - b.effCost || a.c.cost - b.c.cost);
  return pool.map(o => ({
    food_id: o.c.id, name: o.c.name, cat: o.c.cat,
    est_cost: round1(o.effCost), in_stock: o.inStock,
    allergens: [...o.c.allergens],
  }));
}

function assertSubstitutionFood(state, mp, memberId, dish, newFoodId) {
  const fNew = getFood(newFoodId);
  if (!fNew) throw errCode("NO_FOOD", "未知食材：" + newFoodId);
  const family = hh.familyAllergens(state.members);
  const hitFamily = (fNew.allergens || []).filter(a => family.includes(a));
  if (hitFamily.length) throw errCode("ALLERGEN_FAMILY", `「${fNew.name}」含全家规避过敏原 ${hitFamily.join("、")}，不能替换`);
  const member = state.members.find(m => m.id === memberId);
  const hitOwn = (fNew.allergens || []).filter(a => (member.allergens || []).includes(a));
  if (hitOwn.length) throw errCode("ALLERGEN_OWN", `「${fNew.name}」含 ${member.name} 的个人过敏原 ${hitOwn.join("、")}，不能替换`);
  if (mp.params.exclude && mp.params.exclude.includes(newFoodId)) throw errCode("EXCLUDED", `「${fNew.name}」在全家排除清单中`);
  const weeklyUsed = hh.weeklyUsed(state);
  if (fNew.weekly_limit && (weeklyUsed[newFoodId] || 0) >= fNew.weekly_limit) {
    throw errCode("WEEKLY_LIMIT", `「${fNew.name}」本周限用 ${fNew.weekly_limit} 次，已达上限`);
  }
  const fOld = getFood(dish.food_id);
  if (fNew.cat !== fOld.cat) throw errCode("CATEGORY_MISMATCH", `替换必须在同类（${fOld.cat}）食材内进行`);
  if (dish.role === "protein" && fNew.per100g.protein < 10) throw errCode("NOT_PROTEIN", "蛋白质主菜只能替换为高蛋白食材");
  return fNew;
}

/* 成员确认自己那一份的替换：accept=true 接受原食材；food_id 非空则替换 */
function confirmSubstitution(state, actorId, input) {
  const mp = currentMealPlan(state);
  assertCurrentCycle(state, mp);
  assertStage(mp, "substitutions");
  const actor = memberById(state, actorId);
  const dish = mp.dishes.find(d => d.id === input.dish_id);
  if (!dish) throw errCode("NO_DISH", "菜品不存在");
  /* 家长可代任一成员确认；普通成员只能确认自己的份 */
  let memberId = actor.id;
  if (input.member_id != null && Number(input.member_id) !== actor.id) {
    if (!hh.hasRole(actor, "parent")) throw errCode("FORBIDDEN_ROLE", "仅家长可代其他成员确认替换");
    memberId = memberById(state, Number(input.member_id)).id;
  }
  if (dish.portions[memberId] == null) throw errCode("NO_MEMBER", "该成员在本菜品中无分餐");

  const before = effectivePortion(dish, memberId);
  if (input.food_id && input.food_id !== before.food_id) {
    const fNew = assertSubstitutionFood(state, mp, memberId, dish, input.food_id);
    const toGrams = input.grams != null ? Math.round(Number(input.grams) * 10) / 10 : before.grams;
    if (!(toGrams > 0)) throw errCode("BAD_GRAMS", "替换克重必须为正数");
    dish.history.push({
      type: "substitute", at: nowIso(), by: actor.id, member_id: memberId,
      from_food_id: before.food_id, to_food_id: fNew.id, to_grams: toGrams,
    });
    dish.member_status[memberId] = { sub: "replaced", food_id: fNew.id, at: nowIso(), by: actor.id };
    mp.audit.push({ at: nowIso(), actor: actor.id, action: "substitute", text: `${actor.name}${memberId !== actor.id ? "代" + (state.members.find(m => m.id === memberId) || {}).name : ""}：${getFood(before.food_id).name} → ${fNew.name}` });
  } else {
    dish.member_status[memberId] = { sub: "ok", food_id: before.food_id, at: nowIso(), by: actor.id };
    mp.audit.push({ at: nowIso(), actor: actor.id, action: "sub-accept", text: `${actor.name}${memberId !== actor.id ? "代" + (state.members.find(m => m.id === memberId) || {}).name : ""} 确认保留「${getFood(before.food_id).name}」` });
  }

  advanceStage(mp);
  syncShopping(state, mp);
  return mp;
}

/* ---------------- 采购同步 ---------------- */

/* 份量 / 替换变动后重建菜单采购项（保留已到货项与手动项、保留负责人），预算与库存由视图实时核算 */
function syncShopping(state, mp) {
  const need = mealNeeds(mp);
  return hh.buildShoppingFromNeeds(state, need);
}

/* ---------------- 采购负责人确认到货（分餐工作流口径） ---------------- */

function arriveForMeal(state, actorId, itemId, opts) {
  const mp = currentMealPlan(state);
  assertCurrentCycle(state, mp);
  assertStage(mp, "arrivals");
  const actor = memberById(state, actorId);
  assertRole(actor, "buyer");
  const it = hh.arriveItem(state, itemId, opts || {});
  mp.audit.push({ at: nowIso(), actor: actor.id, action: "arrive", text: `采购负责人 ${actor.name} 确认「${getFood(it.food_id).name}」到货 ${it.arrived_grams}g，实付 ¥${it.actual_cost}` });
  return it;
}

/* ---------------- 库存消耗（按成员入账） ---------------- */

function assertCurrentCycle(state, mp) {
  if (mp.cycle !== state.cycle_no) {
    throw errCode("STALE_WEEK",
      `该分餐菜单属于第 ${mp.cycle} 采购周，当前为第 ${state.cycle_no} 周：旧菜单仅供追溯，请重新生成本周菜单`);
  }
}

/* 某天全家分餐一次性消耗：按成员 × 生效菜品扣库存，任一不足整体回滚 */
function consumeMealDay(state, dayIndex) {
  const mp = currentMealPlan(state);
  assertCurrentCycle(state, mp);
  dayIndex = Number(dayIndex);
  const plan = mp.plan;
  if (!(dayIndex >= 0 && dayIndex < plan.days.length)) throw errCode("BAD_DAY", "日期序号非法");
  if (mp.consumed_days.includes(dayIndex)) throw errCode("ALREADY_CONSUMED", "该日分餐已确认消耗");
  if (mp.stage !== "arrivals") throw errCode("STAGE_LOCKED", "替换确认完成后才能按分餐消耗");

  const ids = mp.members.map(m => m.member_id);
  const entries = [];
  for (const d of mp.dishes) {
    if (d.day !== dayIndex) continue;
    for (const mid of ids) {
      const eff = effectivePortion(d, mid);
      entries.push({
        food_id: eff.food_id, grams: eff.grams, source: "plan",
        day_index: dayIndex, member: mid, meal_ref: `dish:${d.id}`,
      });
    }
  }
  const logs = hh.consumeEntries(state, entries);
  mp.consumed_days.push(dayIndex);
  mp.consumed_days.sort((a, b) => a - b);
  mp.audit.push({ at: nowIso(), actor: null, action: "consume", text: `第 ${dayIndex + 1} 天分餐已按成员份量消耗（${logs.length} 条入账，库存同步扣减）` });
  return logs;
}

/* ---------------- 周期切换 ---------------- */

function onNewCycle(state) {
  if (state.meal_plan) state.meal_plan.consumed_days = [];
}

/* ---------------- 营养达标度（逐人） ---------------- */

function memberDayNutrition(mp, dayIndex, memberId) {
  const t = { cost: 0 };
  for (const k of NUTRIENT_ORDER) t[k] = 0;
  for (const d of mp.dishes) {
    if (d.day !== dayIndex) continue;
    const eff = effectivePortion(d, memberId);
    const f = getFood(eff.food_id);
    if (!f) continue;
    const n = nutrientsFor(f, eff.grams);
    for (const k of NUTRIENT_ORDER) t[k] += n[k];
    t.cost += costFor(f, eff.grams);
  }
  return t;
}

function adequacyFor(t, req) {
  const out = {};
  const rows = [
    ["kcal", t.kcal, req.kcal], ["protein", t.protein, req.protein], ["fiber", t.fiber, req.fiber],
    ["calcium", t.calcium, req.calcium], ["iron", t.iron, req.iron],
    ["vitA", t.vitA, req.vitA], ["vitC", t.vitC, req.vitC], ["vitD", t.vitD, req.vitD],
    ["potassium", t.potassium, req.potassium],
  ];
  for (const [k, v, target] of rows) out[k] = { value: round1(v), target, pct: Math.round(v / target * 100) };
  out.sodium = { value: round1(t.sodium), max: req.sodium_max, pct: Math.round(t.sodium / req.sodium_max * 100) };
  return out;
}

/* ---------------- 视图快照 ---------------- */

function mealView(state) {
  if (!state.meal_plan || !state.meal_plan.plan) return null;
  const mp = state.meal_plan;
  const stale = mp.cycle !== state.cycle_no;
  const memberMap = new Map(state.members.map(m => [m.id, m]));

  const days = mp.plan.days.map((day, idx) => {
    const members = mp.members.map(mi => {
      const m = memberMap.get(mi.member_id);
      const req = m ? getRequirement(m.profile) : null;
      const t = memberDayNutrition(mp, idx, mi.member_id);
      return {
        member_id: mi.member_id,
        name: mi.name,
        roles: m ? [...(m.roles || [])] : [],
        target_kcal: req ? req.kcal : mi.target_kcal,
        kcal: round1(t.kcal),
        kcal_pct: req ? Math.round(t.kcal / req.kcal * 100) : null,
        cost: round1(t.cost),
        adequacy: req ? adequacyFor(t, req) : null,
        portion_confirmed: !!mi.portion_confirmed,
      };
    });
    return {
      day: day.day, day_name: day.day_name,
      consumed: mp.consumed_days.includes(idx),
      members,
      family_kcal: round1(members.reduce((s, m) => s + m.kcal, 0)),
      family_cost: round1(members.reduce((s, m) => s + m.cost, 0)),
    };
  });

  /* 菜品视图：带当前生效食材名、替换标记、逐人状态与候选 */
  const dishes = mp.dishes.map(d => {
    const per = mp.members.map(mi => {
      const eff = effectivePortion(d, mi.member_id);
      const f = getFood(eff.food_id);
      const st = (d.member_status || {})[mi.member_id];
      return {
        member_id: mi.member_id, name: mi.name,
        grams: eff.grams, food_id: eff.food_id, food_name: f ? f.name : eff.food_id,
        replaced: eff.replaced,
        sub_status: st ? st.sub : "pending",
        own_allergen: f ? (f.allergens || []).some(a => (memberMap.get(mi.member_id) || { allergens: [] }).allergens.includes(a)) : false,
      };
    });
    return {
      id: d.id, day: d.day, meal: d.meal, role: d.role,
      base_food_id: d.food_id, base_name: getFood(d.food_id).name,
      history: d.history, per,
    };
  });

  const needs = mealNeeds(mp);
  const needTotal = round1(Object.values(needs).reduce((s, g) => s + g, 0));

  /* 各阶段待办计数 */
  const memberIds = mp.members.map(m => m.member_id);
  const pendingPortions = mp.members.filter(m => !m.portion_confirmed).map(m => m.member_id);
  let pendingSubs = 0;
  for (const d of mp.dishes) {
    for (const id of memberIds) {
      const st = (d.member_status || {})[id];
      if (!st || st.sub === "pending") pendingSubs++;
    }
  }
  const pendingArrivals = state.shopping
    .filter(i => i.cycle === state.cycle_no && i.status === "pending").length;

  /* 按成员的消耗追溯（本菜单周期） */
  const memberConsumption = mp.members.map(mi => {
    const logs = state.consumption.filter(l => l.cycle === mp.cycle && l.member === mi.member_id);
    return {
      member_id: mi.member_id,
      name: mi.name,
      entries: logs.length,
      grams: round1(logs.reduce((s, l) => s + l.grams, 0)),
      days: [...new Set(logs.map(l => l.day_index).filter(x => x != null))],
    };
  });

  return {
    cycle: mp.cycle,
    stale,
    stage: mp.stage,
    stage_label: STAGE_LABEL[mp.stage],
    created_at: mp.created_at,
    base_kcal: mp.base_kcal,
    total_kcal: mp.total_kcal,
    portions_ready: portionsReady(mp),
    substitutions_ready: substitutionsReady(mp),
    pending: { portions: pendingPortions.length, substitutions: pendingSubs, arrivals: pendingArrivals },
    members: mp.members.map(mi => {
      const m = memberMap.get(mi.member_id);
      return {
        ...mi,
        roles: m ? [...(m.roles || [])] : mi.roles,
        missing: !m,
        allergens: m ? [...m.allergens] : mi.allergens,
      };
    }),
    days,
    dishes,
    needs: Object.entries(needs).map(([food_id, grams]) => {
      const f = getFood(food_id);
      return { food_id, grams: round1(grams), name: f ? f.name : food_id, est_cost: round1(costFor(f, grams)) };
    }),
    need_grams: needTotal,
    member_consumption: memberConsumption,
    consumed_days: [...mp.consumed_days],
    audit: mp.audit,
  };
}

module.exports = {
  STAGES, STAGE_LABEL,
  buildMealPlan, confirmPortions, confirmSubstitution, substitutionCandidates,
  arriveForMeal, consumeMealDay, syncShopping, mealNeeds, effectivePortion,
  mealView, onNewCycle, memberTargets,
};
