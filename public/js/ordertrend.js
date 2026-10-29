// 발주 트렌드(최근 7일 요청 추이 + 인사이트) 계산 로직. staff.js(직원
// 화면)와 owner.js(사장님 화면) 둘 다 같은 데이터를 보여주므로, 집계와
// 인사이트 문장 생성은 여기 한 곳에만 두고 두 화면이 같이 가져다 쓴다
// — 한쪽만 고치고 다른 쪽을 깜빡하는 일이 없도록.
import { db, collection, getDocs } from "./firebase-init.js";
import { escapeHtml } from "./util.js";

// 최근 N일 동안 checks/{date}/items 를 전부 모아서, 자재별로 몇 번
// 요청됐는지/며칠에 걸쳐 요청됐는지/긴급·품절로 요청된 횟수/요청→주문완료
// 소요시간(시간 단위)을 집계한다.
//
// 횟수만으로는 "하루에 몰아서 여러 개 담았다"와 "매일 꾸준히 나간다"를
// 구분할 수 없어서 dayCount도 같이 센다. 그리고 "긴급/품절로 자주
// 요청됨" 하나만 보면 원인이 두 가지로 갈리는 걸 구분을 못 한다 —
// ①발주 자체가 밀려서 한참 뒤에야 주문되는 경우(요청→주문완료 소요시간이
// 김)와, ②빨리 주문은 되는데 그 양이 수요보다 적어서 금방 또 떨어지는
// 경우(소요시간은 짧은데 반복됨). 그래서 updatedAt(요청/마지막 수정
// 시각)과 orderedAt(주문완료 시각) 간격도 같이 모아, 둘을 구분해서 말해줄
// 수 있게 한다.
export async function computeTrendData(recentDates, storeId) {
  const stats = new Map(); // name -> { count, days:Set, urgentCount, gapHours:number[] }
  await Promise.all(
    recentDates.map(async (d) => {
      try {
        const snap = await getDocs(collection(db, "stores", storeId, "checks", d, "items"));
        snap.forEach((doc) => {
          const data = doc.data();
          const name = data.materialName;
          if (!name) return;
          if (!stats.has(name)) stats.set(name, { count: 0, days: new Set(), urgentCount: 0, gapHours: [] });
          const s = stats.get(name);
          s.count += 1;
          s.days.add(d);
          if (data.urgency === "urgent" || data.urgency === "soldout") s.urgentCount += 1;
          if (data.ordered && data.orderedAt && data.updatedAt) {
            const requestedMs = data.updatedAt.toMillis ? data.updatedAt.toMillis() : data.updatedAt.seconds * 1000;
            const orderedMs = data.orderedAt.toMillis ? data.orderedAt.toMillis() : data.orderedAt.seconds * 1000;
            const hours = (orderedMs - requestedMs) / 3600000;
            if (hours >= 0) s.gapHours.push(hours);
          }
        });
      } catch (e) {
        // 그 날짜에 담긴 기록이 없으면 건너뛴다.
      }
    })
  );
  return [...stats.entries()]
    .map(([name, s]) => ({
      name,
      count: s.count,
      dayCount: s.days.size,
      urgentCount: s.urgentCount,
      avgGapHours: s.gapHours.length > 0 ? s.gapHours.reduce((a, b) => a + b, 0) / s.gapHours.length : null,
    }))
    .sort((a, b) => b.count - a.count);
}

// 순위 목록만으로는 "그래서 뭘 어떻게 하라는 건지"가 안 보여서, 데이터에서
// 뽑아낼 수 있는 짧은 인사이트 문장 몇 개를 추가로 만든다 — 아직 1주일치
// 데이터라 꺾은선 그래프로 보여주기엔 너무 들쭉날쭉해서, 지금은 이 정도가
// 적당하다고 판단했다. 나중에 몇 달치가 쌓이면 그때 계절별 추이나 실제
// 판매 데이터 연동까지 붙여서 제대로 된 차트로 확장하면 된다.
//
// dayWindowLength는 집계에 쓴 날짜 수(기본 7) — "거의 매일 요청" 기준을
// 그 창 길이에 맞춰 판단한다.
export function trendInsightsHtml(trendData, dayWindowLength) {
  if (trendData.length === 0) return "";
  const insights = [];
  const top = trendData[0];
  insights.push(`가장 자주 요청된 자재는 <strong>${escapeHtml(top.name)}</strong>이에요 (최근 7일간 ${top.count}회, ${top.dayCount}일에 걸쳐 요청).`);

  const daily = trendData.filter((t) => t.dayCount >= dayWindowLength - 1);
  if (daily.length > 0) {
    insights.push(`<strong>${daily.map((t) => escapeHtml(t.name)).join(", ")}</strong>${daily.length === 1 ? "은" : "는"} 거의 매일 요청되고 있어요 — 재고를 넉넉히 준비해두면 좋을 것 같아요.`);
  }

  // 긴급/품절로 자주 요청된 것들을, "요청해도 주문이 한참 늦게 처리됨"(발주
  // 누락 의심)과 "빨리 주문되는데도 금방 또 떨어짐"(수량 부족 의심)으로
  // 나눠서 말해준다 — 원인이 다르면 해결책도 다르다.
  const urgentWithGap = [...trendData].filter((t) => t.urgentCount > 0 && t.avgGapHours != null);
  const slowToOrder = urgentWithGap.filter((t) => t.avgGapHours >= 24).sort((a, b) => b.avgGapHours - a.avgGapHours);
  const quicklyReorderedButStillShort = urgentWithGap.filter((t) => t.avgGapHours < 24).sort((a, b) => b.urgentCount - a.urgentCount);
  const urgentNoGapData = [...trendData].filter((t) => t.urgentCount > 0 && t.avgGapHours == null);

  if (slowToOrder.length > 0) {
    insights.push(`<strong>${slowToOrder.slice(0, 3).map((t) => escapeHtml(t.name)).join(", ")}</strong>${slowToOrder.length === 1 ? "은" : "는"} 긴급 요청해도 주문완료까지 평균 ${Math.round(slowToOrder[0].avgGapHours / 24)}일 정도 걸렸어요 — 수량 문제라기보단 발주가 밀려서 늦어지는 걸로 보여요, 요청이 바로바로 처리되고 있는지 확인해보세요.`);
  }
  if (quicklyReorderedButStillShort.length > 0) {
    insights.push(`<strong>${quicklyReorderedButStillShort.slice(0, 3).map((t) => escapeHtml(t.name)).join(", ")}</strong>${quicklyReorderedButStillShort.length === 1 ? "은" : "는"} 요청하면 금방 주문되는데도 긴급/품절이 자주 생겨요 — 한 번에 시키는 양을 늘려보면 좋을 것 같아요.`);
  }
  if (urgentNoGapData.length > 0 && slowToOrder.length === 0 && quicklyReorderedButStillShort.length === 0) {
    insights.push(`<strong>${urgentNoGapData.slice(0, 3).map((t) => escapeHtml(t.name)).join(", ")}</strong>${urgentNoGapData.length === 1 ? "은" : "는"} 긴급/품절로 요청된 적이 있어요 — 재고 소진 주기를 한번 확인해보세요.`);
  }

  const burst = trendData.filter((t) => t.count >= 3 && t.dayCount === 1);
  if (burst.length > 0) {
    insights.push(`<strong>${burst.slice(0, 3).map((t) => escapeHtml(t.name)).join(", ")}</strong>${burst.length === 1 ? "은" : "는"} 하루에 몰아서 여러 번 요청됐어요 — 한 번에 더 넉넉히 시켜두면 반복 요청을 줄일 수 있어요.`);
  }

  return `
    <div class="trend-insight-card">
      <div class="trend-insight-title">💡 이번 주 인사이트</div>
      <ul class="trend-insight-list">
        ${insights.map((i) => `<li>${i}</li>`).join("")}
      </ul>
    </div>`;
}

export function trendListHtml(trendData) {
  const maxCount = trendData.length > 0 ? trendData[0].count : 0;
  return `
    <div class="trend-list">
      ${trendData.map((t, i) => `
        <div class="trend-row">
          <div class="trend-rank">${i + 1}</div>
          <div class="trend-info">
            <div class="trend-name">${escapeHtml(t.name)}${t.urgentCount > 0 ? " 🚨" : ""}</div>
            <div class="trend-bar-track"><div class="trend-bar-fill" style="width:${maxCount ? Math.round((t.count / maxCount) * 100) : 0}%"></div></div>
          </div>
          <div class="trend-count">${t.count}회${t.dayCount > 1 ? ` · ${t.dayCount}일` : ""}</div>
        </div>`).join("")}
    </div>`;
}
