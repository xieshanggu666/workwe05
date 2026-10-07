"use strict";
/* 家庭分餐协作测试：角色权限、按成员营养目标分餐、三阶段确认流水线、
   替换过敏拦截、采购预算同步、按成员入账的库存消耗、可追溯与周期失效。 */
const assert = require("assert");
const hh = require("../engine/household");
const mp = require("../engine/mealplan");
const foodsMod = require("../engine/foods");

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("ok  -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "::", e.message); }
}
async function ta(name, fn) {
  try { await fn(); passed++; console.log("ok  -", name); }
  catch (e) { failed++; console.log("FAIL -", name, "::", e.message); }
}

function family3() {
  const s = hh.emptyHousehold();
  const dad = hh.addMember(s, { name: "爸爸", roles: ["parent", "buyer"], profile: { age_group: "adult_m", activity: "moderate", goal: "maintain" } });
  const mom = hh.addMember(s, { name: "妈妈", roles: [], profile: { age_group: "adult_f", activity: "light", goal: "lose" }, allergens: ["鱼"] });
  const kid = hh.addMember(s, { name: "宝宝", roles: [], profile: { age_group: "child", activity: "moderate", goal: "maintain" } });
  return { s, dad, mom, kid };
}

function buildAndSync(s) {
  const plan = mp.buildMealPlan(s, {});
  mp.syncShopping(s, plan);
  return plan;
}

/* ---------- 角色 ---------- */
t("无成员 / 缺角色时不能生成分餐菜单", () => {
  const s = hh.emptyHousehold();
  hh.addMember(s, { name: "甲" });
  assert.throws(() => mp.buildMealPlan(s, {}), /家长/);
  hh.updateMember(s, 1, { roles: ["parent"] });
  assert.throws(() => mp.buildMealPlan(s, {}), /采购负责人/);
});

t("角色完整性：唯一家长 / 唯一采购负责人不能被移除角色或删除", () => {
  const s = hh.emptyHousehold();
  const dad = hh.addMember(s, { name: "爸爸", roles: ["parent"] });
  const buyer = hh.addMember(s, { name: "采买", roles: ["buyer"] });
  assert.throws(() => hh.updateMember(s, dad.id, { roles: [] }), /家长/);
  assert.throws(() => hh.removeMember(s, dad.id), /家长/);
  assert.throws(() => hh.updateMember(s, buyer.id, { roles: [] }), /采购负责人/);
  assert.throws(() => hh.removeMember(s, buyer.id), /采购负责人/);
});

t("未启用协作角色的家庭保持向后兼容（可直接删除成员）", () => {
  const s = hh.emptyHousehold();
  const m = hh.addMember(s, { name: "普通" });
  hh.removeMember(s, m.id);
  assert.strictEqual(s.members.length, 0);
});

/* ---------- 按成员营养目标分餐 ---------- */
t("按成员热量目标分摊：各成员每日热量贴近自身 RNI 目标", () => {
  const { s } = family3();
  buildAndSync(s);
  const v = mp.mealView(s);
  for (const day of v.days) {
    for (const m of day.members) {
      assert(m.kcal_pct >= 85 && m.kcal_pct <= 115, `${day.day_name} ${m.name} 热量达成 ${m.kcal_pct}%`);
    }
  }
});

t("儿童份额小于成年男性份额", () => {
  const { s, dad, kid } = family3();
  const plan = buildAndSync(s);
  let dadG = 0, kidG = 0;
  for (const d of plan.dishes) { dadG += d.portions[dad.id]; kidG += d.portions[kid.id]; }
  assert(kidG < dadG, `儿童总克重 ${kidG} 应小于父亲 ${dadG}`);
});

t("全家过敏原并集参与基底菜单（妈妈规避鱼类）", () => {
  const { s } = family3();
  const plan = buildAndSync(s);
  const fishIds = foodsMod.FOODS.filter(f => f.allergens.includes("鱼")).map(f => f.id);
  for (const d of plan.dishes) assert(!fishIds.includes(d.food_id), "菜单出现鱼类: " + d.food_id);
});

/* ---------- 阶段一：家长确认份量 ---------- */
t("份量阶段：非家长不能确认；家长可微调克重并留痕", () => {
  const { s, dad, mom, kid } = family3();
  const plan = buildAndSync(s);
  assert.throws(() => mp.confirmPortions(s, mom.id, {}), e => e.code === "FORBIDDEN_ROLE");
  const dish = plan.dishes[0];
  const before = dish.portions[kid.id];
  mp.confirmPortions(s, dad.id, { member_id: kid.id, adjustments: [{ dish_id: dish.id, member_id: kid.id, grams: before + 30 }] });
  assert.strictEqual(dish.portions[kid.id], before + 30);
  const trace = dish.history.find(h => h.type === "portion" && h.member_id === kid.id);
  assert(trace && trace.by === dad.id && trace.to_grams === before + 30);
});

t("未完成份量确认不能进入替换阶段", () => {
  const { s, dad } = family3();
  const plan = buildAndSync(s);
  assert.throws(() => mp.confirmSubstitution(s, dad.id, { dish_id: plan.dishes[0].id }), e => e.code === "STAGE_LOCKED");
});

/* ---------- 阶段二：成员确认替换 ---------- */
t("替换阶段：普通成员只能处理自己的份，家长可代确认", () => {
  const { s, dad, mom, kid } = family3();
  const plan = buildAndSync(s);
  for (const m of s.members) mp.confirmPortions(s, dad.id, { member_id: m.id });
  const dish = plan.dishes[0];
  assert.throws(() => mp.confirmSubstitution(s, mom.id, { dish_id: dish.id, member_id: kid.id }), e => e.code === "FORBIDDEN_ROLE");
  mp.confirmSubstitution(s, dad.id, { dish_id: dish.id, member_id: kid.id }); // 家长代确认
  assert.strictEqual(dish.member_status[kid.id].sub, "ok");
});

t("替换候选：同类食材、库存优先、含个人过敏原的不出现", () => {
  const { s, dad, kid } = family3();
  const plan = buildAndSync(s);
  for (const m of s.members) mp.confirmPortions(s, dad.id, { member_id: m.id });
  hh.updateMember(s, kid.id, { allergens: ["虾", "贝类"] });
  const dish = plan.dishes.find(d => d.role === "protein");
  const cands = mp.substitutionCandidates(s, plan, dish, kid.id);
  assert(cands.length > 0);
  assert(!cands.some(c => c.food_id === "shrimp" || c.food_id === "scallop"));
  assert(cands.every(c => foodsMod.getFood(c.food_id).per100g.protein >= 10), "蛋白菜候选必须高蛋白");
});

t("替换为含全家 / 个人过敏原或跨类食材被拦截", () => {
  const { s, dad, kid } = family3();
  const plan = buildAndSync(s);
  for (const m of s.members) mp.confirmPortions(s, dad.id, { member_id: m.id });
  const protein = plan.dishes.find(d => d.role === "protein");
  /* 个人过敏原加入后自动并入全家并集（严格规避语义）：替换虾被拦截 */
  hh.updateMember(s, kid.id, { allergens: ["虾"] });
  assert.throws(() => mp.confirmSubstitution(s, kid.id, { dish_id: protein.id, food_id: "shrimp" }), /过敏原/);
  /* 替换候选中同时排除全家与个人过敏原 */
  assert(!mp.substitutionCandidates(s, plan, protein, kid.id).some(c => c.food_id === "shrimp"));
  /* 跨类替换（蔬菜替肉）拦截 */
  assert.throws(() => mp.confirmSubstitution(s, kid.id, { dish_id: protein.id, food_id: "broccoli" }), e => e.code === "CATEGORY_MISMATCH");
});

t("替换生效后：净采购需求与采购清单同步变化（新食材出现、旧食材不消失则共存）", () => {
  const { s, dad, kid } = family3();
  const plan = buildAndSync(s);
  for (const m of s.members) mp.confirmPortions(s, dad.id, { member_id: m.id });
  const protein = plan.dishes.find(d => d.role === "protein");
  const oldId = mp.effectivePortion(protein, kid.id).food_id;
  const cand = mp.substitutionCandidates(s, plan, protein, kid.id)[0];
  const shopBefore = new Set(s.shopping.map(i => i.food_id));
  mp.confirmSubstitution(s, kid.id, { dish_id: protein.id, food_id: cand.food_id });
  mp.syncShopping(s, plan);
  const shopAfter = new Set(s.shopping.map(i => i.food_id));
  assert(shopAfter.has(cand.food_id), "替换后的新食材应进入采购清单");
  /* 其余成员仍点旧食材时，旧食材应仍在清单 */
  const othersKeepOld = plan.dishes.some(d => d.id !== protein.id && d.food_id === oldId)
    || Object.keys(protein.portions).some(mid => Number(mid) !== kid.id && mp.effectivePortion(protein, Number(mid)).food_id === oldId);
  if (othersKeepOld) assert(shopAfter.has(oldId), "其他成员仍需要的旧食材不应消失");
  /* 替换记录可追溯 */
  const hist = protein.history.filter(h => h.type === "substitute" && h.member_id === kid.id).pop();
  assert(hist && hist.from_food_id === oldId && hist.to_food_id === cand.food_id && hist.by === kid.id);
});

t("全部成员完成替换确认后自动进入到货阶段", () => {
  const { s, dad } = family3();
  const plan = buildAndSync(s);
  for (const m of s.members) mp.confirmPortions(s, dad.id, { member_id: m.id });
  const ids = plan.members.map(m => m.member_id);
  for (const d of plan.dishes) for (const mid of ids) {
    mp.confirmSubstitution(s, mid, { dish_id: d.id });
  }
  assert.strictEqual(plan.stage, "arrivals");
});

/* ---------- 阶段三：采购负责人确认到货 + 预算同步 ---------- */
t("到货阶段：非采购负责人被拒；到货后预算实际支出更新", () => {
  const { s, dad, mom } = family3();
  const plan = buildAndSync(s);
  for (const m of s.members) mp.confirmPortions(s, dad.id, { member_id: m.id });
  const ids = plan.members.map(m => m.member_id);
  for (const d of plan.dishes) for (const mid of ids) mp.confirmSubstitution(s, mid, { dish_id: d.id });
  const item = s.shopping.find(i => i.status === "pending");
  assert.throws(() => mp.arriveForMeal(s, mom.id, item.id, {}), e => e.code === "FORBIDDEN_ROLE");
  mp.arriveForMeal(s, dad.id, item.id, { grams: item.grams + 100, unit_cost: foodsMod.getFood(item.food_id).cost });
  const b = hh.budgetSummary(s);
  assert(b.spent > 0);
  assert(hh.stockOnHand(s)[item.food_id] === item.grams + 100);
});

t("在替换阶段提前到货被阶段锁拒绝", () => {
  const { s, dad } = family3();
  const plan = buildAndSync(s);
  for (const m of s.members) mp.confirmPortions(s, dad.id, { member_id: m.id });
  const item = s.shopping.find(i => i.status === "pending");
  assert.throws(() => mp.arriveForMeal(s, dad.id, item.id, {}), e => e.code === "STAGE_LOCKED");
});

/* ---------- 库存消耗按成员入账 ---------- */
t("按天分餐消耗：按成员 × 菜品逐条入账、可追溯到菜品，缺料整体回滚", () => {
  const { s, dad } = family3();
  const plan = buildAndSync(s);
  for (const m of s.members) mp.confirmPortions(s, dad.id, { member_id: m.id });
  const ids = plan.members.map(m => m.member_id);
  for (const d of plan.dishes) for (const mid of ids) mp.confirmSubstitution(s, mid, { dish_id: d.id });
  /* 未到货：缺料拦截且零入账 */
  const before = s.consumption.length;
  try { mp.consumeMealDay(s, 0); assert.fail("应缺料"); }
  catch (e) { assert.strictEqual(e.code, "INSUFFICIENT_STOCK"); assert(e.deficits.length > 0); }
  assert.strictEqual(s.consumption.length, before);
  /* 全部到货 */
  for (const it of s.shopping.filter(i => i.status === "pending")) mp.arriveForMeal(s, dad.id, it.id, {});
  const logs = mp.consumeMealDay(s, 0);
  assert(logs.length > 0);
  assert(logs.every(l => l.member != null && /^dish:\d+$/.test(l.meal_ref || "")));
  const members = new Set(logs.map(l => l.member));
  assert.strictEqual(members.size, 3);
  /* 库存按当日全家需求扣减且不为负 */
  for (const g of Object.values(hh.stockOnHand(s))) assert(g >= 0);
  /* 重复消耗拒绝 */
  assert.throws(() => mp.consumeMealDay(s, 0), e => e.code === "ALREADY_CONSUMED");
});

t("视图含成员消耗追溯（条数 / 克重 / 覆盖天）", () => {
  const { s, dad } = family3();
  const plan = buildAndSync(s);
  for (const m of s.members) mp.confirmPortions(s, dad.id, { member_id: m.id });
  const ids = plan.members.map(m => m.member_id);
  for (const d of plan.dishes) for (const mid of ids) mp.confirmSubstitution(s, mid, { dish_id: d.id });
  for (const it of s.shopping.filter(i => i.status === "pending")) mp.arriveForMeal(s, dad.id, it.id, {});
  mp.consumeMealDay(s, 0);
  const v = mp.mealView(s);
  for (const mc of v.member_consumption) {
    assert(mc.entries > 0 && mc.grams > 0 && mc.days.includes(0), mc.name);
  }
});

/* ---------- 预算 / 库存同步与过敏预警 ---------- */
t("分餐菜单重建采购清单幂等：同步多次任务克重不塌缩", () => {
  const { s } = family3();
  const plan = buildAndSync(s);
  const g1 = s.shopping.filter(i => i.status === "pending").reduce((sum, i) => sum + i.grams, 0);
  mp.syncShopping(s, plan); mp.syncShopping(s, plan);
  const g3 = s.shopping.filter(i => i.status === "pending").reduce((sum, i) => sum + i.grams, 0);
  assert.strictEqual(g1, g3);
});

t("份量调增后净采购需求上升，预算预计支出同步上升", () => {
  const { s, dad, kid } = family3();
  const plan = buildAndSync(s);
  const proj0 = hh.budgetSummary(s).committed;
  for (const m of s.members) {
    mp.confirmPortions(s, dad.id, {
      member_id: m.id,
      adjustments: plan.dishes.map(d => ({ dish_id: d.id, member_id: m.id, grams: Math.round(d.portions[m.id] * 1.2 * 10) / 10 })),
    });
  }
  const proj1 = hh.budgetSummary(s).committed;
  assert(proj1 > proj0, `${proj1} 应大于 ${proj0}`);
});

t("手动采购项抵扣菜单净需求", () => {
  const { s } = family3();
  const plan = buildAndSync(s);
  const first = s.shopping.find(i => i.source === "menu" && i.status === "pending");
  const fid = first.food_id;
  /* 用一笔足量手动待买覆盖后，该食材菜单任务消失 */
  const coverNeed = Math.ceil((mp.mealNeeds(plan)[fid] * 1.1) / 10) * 10;
  hh.addManualItem(s, { food_id: fid, grams: coverNeed });
  mp.syncShopping(s, plan);
  assert(!s.shopping.some(i => i.source === "menu" && i.food_id === fid && i.status === "pending"));
  assert(s.shopping.some(i => i.source === "manual" && i.food_id === fid));
});

/* ---------- 周期与追溯 ---------- */
t("周期切换后旧分餐菜单标记过期且不可再入账", () => {
  const { s, dad } = family3();
  const plan = buildAndSync(s);
  for (const m of s.members) mp.confirmPortions(s, dad.id, { member_id: m.id });
  const ids = plan.members.map(m => m.member_id);
  for (const d of plan.dishes) for (const mid of ids) mp.confirmSubstitution(s, mid, { dish_id: d.id });
  for (const it of s.shopping.filter(i => i.status === "pending")) mp.arriveForMeal(s, dad.id, it.id, {});
  mp.consumeMealDay(s, 0);
  hh.startNewCycle(s);
  assert.strictEqual(mp.mealView(s).stale, true);
  assert.throws(() => mp.consumeMealDay(s, 1), e => e.code === "STALE_WEEK");
  /* 审计与历史消耗仍保留可追溯 */
  assert(mp.mealView(s).audit.length > 0);
  assert(s.consumption.some(l => l.cycle === 1 && l.meal_ref));
});

t("完整流程视图字段完整", () => {
  const { s } = family3();
  buildAndSync(s);
  const v = mp.mealView(s);
  assert(v.stage === "portions" && v.pending.portions === 3);
  assert(v.days.length === 7 && v.dishes.length > 0);
  assert(v.needs.length > 0 && v.need_grams > 0);
  assert(v.members.length === 3 && v.audit.length >= 1);
  for (const day of v.days) for (const m of day.members) assert(m.adequacy.kcal);
});

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
