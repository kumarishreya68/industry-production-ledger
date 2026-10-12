// Industry Production Ledger — Dashboard logic
// Uses the existing Express API. Does not access PostgreSQL directly.

const $ = id => document.getElementById(id);

const state = {
  machine: {},
  currentShift: null,
  shifts: [],
  ledger: [],
  events: [],
  page: "live",
  eventFilter: "",
  eventSearch: "",
  eventDate: "",
  eventLimit: 100
};

const fmt = value => Number(value || 0).toLocaleString();

const dateFmt = value => value
  ? new Date(value).toLocaleString()
  : "—";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function rate(good, rejects) {
  const total = Number(good || 0) + Number(rejects || 0);
  return total ? Number(rejects || 0) / total * 100 : 0;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The server returned an unreadable response.");
  }

  if (!response.ok) {
    throw new Error(
      data.message || data.error || `Request failed (${response.status})`
    );
  }

  return data;
}

let toastTimer;

function notify(message, error = false) {
  const toast = $("toast");
  if (!toast) {
    alert(message);
    return;
  }

  toast.textContent = message;
  toast.style.background = error ? "#8f4239" : "#26362b";
  toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4000);
}

function setConnection(connected) {
  const dot = $("connectionDot");
  const text = $("connectionText");

  if (dot) dot.classList.toggle("live", connected);
  if (text) text.textContent = connected
    ? "Server connected"
    : "Connection issue";
}

function badge(status) {
  const value = String(status || "unknown").toLowerCase();
  let color = "gray";

  if (value === "verified" || value === "running") color = "green";
  if (value === "ended") color = "amber";
  if (value === "error") color = "red";

  return `<span class="badge ${color}">${escapeHtml(value)}</span>`;
}

function showPage(page) {
  state.page = page;

  document.querySelectorAll(".page").forEach(element => {
    element.classList.toggle("active", element.id === `page-${page}`);
  });

  document.querySelectorAll(".nav-btn").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  const labels = {
    live: "Live Monitoring",
    shifts: "Shift Management",
    ledger: "Production Ledger",
    analytics: "Performance Analytics",
    events: "Machine Event History",
    reports: "Reports & Export"
  };

  if ($("breadcrumb")) $("breadcrumb").textContent = labels[page] || page;

  if (page === "shifts") loadShifts();
  if (page === "ledger") loadLedger();
  if (page === "analytics") loadAnalytics();
  if (page === "events") loadEvents();
  if (page === "reports") renderReports();
}

function setupNavigation() {
  document.querySelectorAll(".nav-btn").forEach(button => {
    button.addEventListener("click", () => showPage(button.dataset.page));
  });
}

function renderEvents(events, containerId = "liveTimeline") {
  const container = $(containerId);
  if (!container) return;

  if (!events.length) {
    container.innerHTML = '<div class="empty">No machine events found.</div>';
    return;
  }

  container.innerHTML = events.map(event => {
    const type = String(event.event_type || "normal").toLowerCase();
    let message = event.details || event.event_type || "Machine event";

    if (typeof message === "object") {
      message = message.message || message.description || "Machine event";
    } else if (typeof message === "string") {
      try {
        const parsed = JSON.parse(message);
        message = parsed.message || parsed.description || message;
      } catch {}
    }

    return `
      <div class="event">
        <span class="event-mark ${escapeHtml(type)}"></span>
        <div>
          <div class="event-title">${escapeHtml(message)}</div>
          <div class="event-meta">
            ${escapeHtml(dateFmt(event.occurred_at))}
            · ${escapeHtml(type)}
            ${event.shift_id ? ` · Shift ${escapeHtml(event.shift_id)}` : ""}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

async function loadLive() {
  try {
    const [machine, eventData, shiftData] = await Promise.all([
      api("/api/machine-data"),
      api("/api/machine-events?limit=40"),
      api("/api/shifts/current")
    ]);

    state.machine = machine || {};
    state.events = eventData.events || [];
    state.currentShift = shiftData.shift ||
      (shiftData.id ? shiftData : null);

    setConnection(true);
    renderLive();
  } catch (error) {
    setConnection(false);
    console.error("Live refresh failed:", error);
  }
}

function renderLive() {
  const machine = state.machine;
  const good = Number(machine.good_output || 0);
  const rejects = Number(machine.reject_count || 0);
  const down = Number(machine.downtime_minutes || 0);
  const shiftId = state.currentShift?.id || machine.active_shift_id;

  const values = {
    liveGood: fmt(good),
    liveRejects: fmt(rejects),
    liveDowntime: fmt(down),
    liveRejectRate: rate(good, rejects).toFixed(2) + "%",
    stateGood: fmt(good),
    stateRejects: fmt(rejects),
    stateDowntime: fmt(down)
  };

  Object.entries(values).forEach(([id, value]) => {
    if ($(id)) $(id).textContent = value;
  });

  const max = Math.max(good, rejects, down, 1);
  if ($("goodBar")) $("goodBar").style.width = (good / max * 100) + "%";
  if ($("rejectBar")) $("rejectBar").style.width = (rejects / max * 100) + "%";
  if ($("downBar")) $("downBar").style.width = (down / max * 100) + "%";

  if ($("liveShiftStatus")) {
    $("liveShiftStatus").textContent = shiftId
      ? `Shift ${shiftId} is running`
      : "No active shift";
  }

  if ($("liveShiftTitle")) {
    $("liveShiftTitle").textContent = shiftId
      ? `Production shift #${shiftId}`
      : "Ready for production";
  }

  if ($("liveShiftDescription")) {
    $("liveShiftDescription").textContent = shiftId
      ? `Started ${dateFmt(state.currentShift?.started_at)}.`
      : "Start a shift to record its production totals.";
  }

  if ($("startShiftBtn")) $("startShiftBtn").disabled = Boolean(shiftId);
  if ($("endShiftBtn")) $("endShiftBtn").disabled = !shiftId;
  if ($("shiftDot")) $("shiftDot").classList.toggle("live", Boolean(shiftId));

  if ($("lastRefresh")) {
    $("lastRefresh").textContent = new Date().toLocaleTimeString();
  }

  if ($("eventCount")) {
    $("eventCount").textContent = `${state.events.length} events`;
  }

  renderEvents(state.events.slice(0, 18));
}

async function startShift() {
  if (!confirm("Start a new production shift using the current machine counters as the baseline?")) {
    return;
  }

  try {
    const result = await api("/api/shifts/start", {
      method: "POST",
      body: JSON.stringify({})
    });

    notify(result.message || "Shift started.");
    await Promise.all([loadLive(), loadShifts()]);
  } catch (error) {
    notify(error.message, true);
  }
}

async function endShift() {
  const id = state.currentShift?.id || state.machine.active_shift_id;

  if (!id) {
    notify("There is no active shift to end.", true);
    return;
  }

  if (!confirm(`End shift ${id}? The server will calculate the shift totals.`)) {
    return;
  }

  try {
    const result = await api(`/api/shifts/${id}/end`, {
      method: "POST",
      body: JSON.stringify({})
    });

    notify(result.message || "Shift ended.");
    await Promise.all([loadLive(), loadShifts(), loadLedger()]);
  } catch (error) {
    notify(error.message, true);
  }
}

async function loadShifts() {
  try {
    const [data, current] = await Promise.all([
      api("/api/shifts"),
      api("/api/shifts/current")
    ]);

    state.shifts = Array.isArray(data)
      ? data
      : (data.shifts || data.rows || []);

    state.currentShift = current.shift ||
      (current.id ? current : null);

    renderShifts();
  } catch (error) {
    if ($("activeShiftPanel")) {
      $("activeShiftPanel").innerHTML =
        `<div class="notice error">${escapeHtml(error.message)}</div>`;
    }
  }
}

function renderShifts() {
  const active = state.currentShift ||
    state.shifts.find(shift => shift.status === "running");

  if ($("activeBadge")) {
    $("activeBadge").textContent = active ? "Running" : "No active shift";
  }

  if ($("activeShiftPanel")) {
    $("activeShiftPanel").innerHTML = active
      ? `
        <div class="notice success">Shift #${escapeHtml(active.id)} is running.</div>
        <p class="note">Started</p>
        <strong>${escapeHtml(dateFmt(active.started_at))}</strong>
        <div class="actions" style="margin-top:20px">
          <button class="btn danger" onclick="endShift()">End active shift</button>
        </div>
      `
      : '<div class="empty">No active shift. Start one from Live Monitoring.</div>';
  }

  const pending = state.shifts.filter(s => s.status === "ended");

  if ($("pendingCount")) {
    $("pendingCount").textContent = `${pending.length} pending`;
  }

  if ($("verificationPanel")) {
    $("verificationPanel").innerHTML = pending.length
      ? pending.map(s => `
        <div style="padding:13px 0;border-bottom:1px solid var(--line)">
          <strong>Shift #${escapeHtml(s.id)}</strong>
          ${badge(s.status)}
          <p class="note">Ended ${escapeHtml(dateFmt(s.ended_at))}</p>
          <button class="btn primary" onclick="openVerification(${Number(s.id)})">
            Verify shift
          </button>
        </div>
      `).join("")
      : '<div class="empty">No shifts awaiting verification.</div>';
  }

  if ($("shiftTable")) {
    $("shiftTable").innerHTML = state.shifts.length
      ? state.shifts.map(s => `
        <tr>
          <td>#${escapeHtml(s.id)}</td>
          <td>${escapeHtml(dateFmt(s.started_at))}</td>
          <td>${escapeHtml(dateFmt(s.ended_at))}</td>
          <td>${fmt(s.good_output)}</td>
          <td>${fmt(s.reject_count)}</td>
          <td>${fmt(s.downtime_minutes)} min</td>
          <td>${badge(s.status)}</td>
        </tr>
      `).join("")
      : '<tr><td colspan="7" class="empty">No shifts recorded.</td></tr>';
  }
}

async function openVerification(id) {
  const operator = prompt(`Verify shift ${id}\nEnter operator name:`);
  if (operator === null) return;

  if (!operator.trim()) {
    notify("Operator name is required.", true);
    return;
  }

  const reason = prompt("Enter the stoppage reason:");
  if (reason === null) return;

  if (!reason.trim()) {
    notify("Stoppage reason is required.", true);
    return;
  }

  if (!confirm(`Confirm verification of shift ${id}?`)) return;

  try {
    const result = await api(`/api/shifts/${id}/verify`, {
      method: "POST",
      body: JSON.stringify({
        operator_name: operator.trim(),
        stop_reason: reason.trim()
      })
    });

    notify(result.message || "Shift verified.");
    await Promise.all([loadShifts(), loadLedger(), loadAnalytics()]);
  } catch (error) {
    notify(error.message, true);
  }
}

async function loadLedger() {
  try {
    const [history, shifts] = await Promise.all([
      api("/api/history"),
      api("/api/shifts")
    ]);

    const oldRows = Array.isArray(history)
      ? history
      : (history.history || history.rows || []);

    const shiftRows = Array.isArray(shifts)
      ? shifts
      : (shifts.shifts || shifts.rows || []);

    const keys = new Set(
      shiftRows.filter(s => s.status === "verified").map(s =>
        `${s.operator_name || ""}|${s.good_output}|${s.reject_count}|${s.downtime_minutes}`
      )
    );

    state.ledger = [...shiftRows];

    oldRows.forEach(row => {
      const key = `${row.operator_name || ""}|${row.good_output}|${row.reject_count}|${row.downtime_minutes}`;
      if (!keys.has(key)) {
        state.ledger.push({
          ...row,
          status: row.status || (row.is_verified ? "verified" : "legacy")
        });
      }
    });

    renderLedger();
  } catch (error) {
    if ($("ledgerTable")) {
      $("ledgerTable").innerHTML =
        `<tr><td colspan="9" class="empty">${escapeHtml(error.message)}</td></tr>`;
    }
  }
}

function filteredLedger() {
  const query = ($("ledgerSearch")?.value || "").toLowerCase();
  const status = $("ledgerStatus")?.value || "";

  return state.ledger.filter(row => {
    const searchable = [
      row.id, row.operator_name, row.status, row.stop_reason,
      row.created_at, row.started_at
    ].join(" ").toLowerCase();

    return searchable.includes(query) &&
      (!status || String(row.status).toLowerCase() === status);
  });
}

function renderLedger() {
  const rows = filteredLedger();

  if ($("ledgerCount")) $("ledgerCount").textContent = fmt(rows.length);
  if ($("ledgerGood")) {
    $("ledgerGood").textContent = fmt(rows.reduce((n, r) => n + Number(r.good_output || 0), 0));
  }
  if ($("ledgerRejects")) {
    $("ledgerRejects").textContent = fmt(rows.reduce((n, r) => n + Number(r.reject_count || 0), 0));
  }

  if ($("ledgerTable")) {
    $("ledgerTable").innerHTML = rows.length
      ? rows.map(r => `
        <tr>
          <td>#${escapeHtml(r.id)}</td>
          <td>${escapeHtml(r.operator_name || "—")}</td>
          <td>${escapeHtml(dateFmt(r.started_at || r.created_at))}</td>
          <td>${escapeHtml(dateFmt(r.ended_at))}</td>
          <td>${fmt(r.good_output)}</td>
          <td>${fmt(r.reject_count)}</td>
          <td>${fmt(r.downtime_minutes)} min</td>
          <td>${escapeHtml(r.stop_reason || "—")}</td>
          <td>${badge(r.status)}</td>
        </tr>
      `).join("")
      : '<tr><td colspan="9" class="empty">No matching records.</td></tr>';
  }
}

async function loadAnalytics() {
  try {
    const data = await api("/api/shifts");
    const all = Array.isArray(data)
      ? data
      : (data.shifts || data.rows || []);

    const rows = all.filter(s =>
      s.status === "verified" || s.status === "ended"
    );

    const good = rows.reduce((n, s) => n + Number(s.good_output || 0), 0);
    const rejects = rows.reduce((n, s) => n + Number(s.reject_count || 0), 0);
    const down = rows.reduce((n, s) => n + Number(s.downtime_minutes || 0), 0);

    if ($("anShiftCount")) $("anShiftCount").textContent = fmt(rows.length);
    if ($("anGood")) $("anGood").textContent = fmt(good);
    if ($("anRejectRate")) $("anRejectRate").textContent = rate(good, rejects).toFixed(2) + "%";
    if ($("anDown")) $("anDown").textContent = fmt(down);

    renderBarChart("outputChart", rows, "good_output", "Good output");
    renderBarChart("downtimeChart", rows, "downtime_minutes", "Downtime (min)");

    if ($("analyticsTable")) {
      $("analyticsTable").innerHTML = rows.length
        ? rows.map(s => `
          <tr>
            <td>#${escapeHtml(s.id)}</td>
            <td>${fmt(s.good_output)}</td>
            <td>${fmt(s.reject_count)}</td>
            <td>${rate(s.good_output, s.reject_count).toFixed(2)}%</td>
            <td>${fmt(s.downtime_minutes)} min</td>
          </tr>
        `).join("")
        : '<tr><td colspan="5" class="empty">No completed shifts available.</td></tr>';
    }

    if ($("insights")) {
      const best = rows.slice().sort((a, b) =>
        Number(b.good_output || 0) - Number(a.good_output || 0)
      )[0];

      $("insights").innerHTML = best
        ? `<div class="insight"><strong>Highest recorded output</strong><p>Shift #${escapeHtml(best.id)} recorded ${fmt(best.good_output)} good units.</p></div>`
        : '<div class="empty">Complete a shift to generate insights.</div>';
    }
  } catch (error) {
    if ($("insights")) {
      $("insights").innerHTML =
        `<div class="notice error">${escapeHtml(error.message)}</div>`;
    }
  }
}

function renderBarChart(containerId, rows, field, label) {
  const container = $(containerId);
  if (!container) return;

  if (!rows.length) {
    container.innerHTML = '<div class="empty">Complete a shift to display a chart.</div>';
    return;
  }

  const values = rows.slice(-10);
  const max = Math.max(...values.map(r => Number(r[field] || 0)), 1);
  const width = 560, height = 220, left = 40, right = 12, top = 15, bottom = 43;
  const chartH = height - top - bottom;
  const chartW = width - left - right;
  const step = chartW / values.length;

  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${label} chart">`;

  for (let i = 0; i <= 4; i++) {
    const y = top + chartH * i / 4;
    svg += `<line x1="${left}" y1="${y}" x2="${width-right}" y2="${y}" stroke="#edf0eb"/>`;
    svg += `<text x="${left-7}" y="${y+4}" text-anchor="end" font-size="10" fill="#899189">${Math.round(max * (4-i) / 4)}</text>`;
  }

  values.forEach((row, i) => {
    const value = Number(row[field] || 0);
    const barH = value / max * (chartH - 4);
    const x = left + i * step + step * .2;
    const barW = step * .6;
    const y = top + chartH - barH;

    svg += `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="3" fill="#8ba78b"><title>Shift ${escapeHtml(row.id)}: ${value}</title></rect>`;
    svg += `<text x="${x + barW/2}" y="${height-19}" text-anchor="middle" font-size="10" fill="#899189">#${escapeHtml(row.id)}</text>`;
  });

  container.innerHTML = svg + "</svg>";
}

async function loadEvents() {
  try {
    const data = await api(`/api/machine-events?limit=${state.eventLimit}`);
    state.events = data.events || [];
    renderEventHistory();
  } catch (error) {
    if ($("eventHistoryList")) {
      $("eventHistoryList").innerHTML =
        `<div class="notice error">${escapeHtml(error.message)}</div>`;
    }
  }
}

function renderEventHistory() {
  const search = ($("eventSearch")?.value || "").toLowerCase();
  const type = $("eventTypeFilter")?.value || "";
  const date = $("eventDateFilter")?.value || "";

  const filtered = state.events.filter(event => {
    let message = event.details || "";
    if (typeof message === "object") message = JSON.stringify(message);

    const matchesSearch = `${message} ${event.event_type} ${event.shift_id || ""}`
      .toLowerCase().includes(search);

    const matchesType = !type || event.event_type === type;
    const matchesDate = !date || (
      event.occurred_at &&
      new Date(event.occurred_at).toLocaleDateString("en-CA") === date
    );

    return matchesSearch && matchesType && matchesDate;
  });

  if ($("eventHistoryCount")) {
    $("eventHistoryCount").textContent = `${filtered.length} events`;
  }

  renderEvents(filtered, "eventHistoryList");
}

function downloadCSV(filename, rows) {
  if (!rows.length) {
    notify("There are no records to export.", true);
    return;
  }

  const columns = Object.keys(rows[0]);
  const quote = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [
    columns.map(quote).join(","),
    ...rows.map(row => columns.map(key => quote(row[key])).join(","))
  ].join("\r\n");

  const blob = new Blob(["\uFEFF" + csv], {
    type: "text/csv;charset=utf-8;"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  notify("CSV export started.");
}

function exportLedger() {
  const rows = filteredLedger().map(row => ({
    shift_id: row.id,
    operator_name: row.operator_name || "",
    started_at: row.started_at || row.created_at || "",
    ended_at: row.ended_at || "",
    good_output: row.good_output || 0,
    reject_count: row.reject_count || 0,
    downtime_minutes: row.downtime_minutes || 0,
    stop_reason: row.stop_reason || "",
    status: row.status || ""
  }));

  downloadCSV("production-ledger.csv", rows);
}

function exportEvents() {
  const rows = state.events.map(event => ({
    event_id: event.id,
    shift_id: event.shift_id || "",
    event_type: event.event_type || "",
    occurred_at: event.occurred_at || "",
    duration_minutes: event.duration_minutes || 0,
    details: typeof event.details === "object"
      ? JSON.stringify(event.details)
      : event.details || ""
  }));

  downloadCSV("machine-event-history.csv", rows);
}

function renderReports() {
  const rows = state.ledger;
  const good = rows.reduce((n, r) => n + Number(r.good_output || 0), 0);
  const rejects = rows.reduce((n, r) => n + Number(r.reject_count || 0), 0);
  const down = rows.reduce((n, r) => n + Number(r.downtime_minutes || 0), 0);

  if ($("reportCount")) $("reportCount").textContent = fmt(rows.length);
  if ($("reportGood")) $("reportGood").textContent = fmt(good);
  if ($("reportRejects")) $("reportRejects").textContent = fmt(rejects);
  if ($("reportDowntime")) $("reportDowntime").textContent = fmt(down);
  if ($("reportRejectRate")) $("reportRejectRate").textContent = rate(good, rejects).toFixed(2) + "%";
}

function exportReport() {
  const start = $("reportStartDate")?.value || "";
  const end = $("reportEndDate")?.value || "";

  const rows = state.ledger.filter(row => {
    const rawDate = row.started_at || row.created_at;
    if (!rawDate) return !start && !end;

    const day = new Date(rawDate).toISOString().slice(0, 10);
    return (!start || day >= start) && (!end || day <= end);
  });

  downloadCSV("production-report.csv", rows.map(row => ({
    shift_id: row.id,
    operator_name: row.operator_name || "",
    started_at: row.started_at || row.created_at || "",
    ended_at: row.ended_at || "",
    good_output: row.good_output || 0,
    reject_count: row.reject_count || 0,
    downtime_minutes: row.downtime_minutes || 0,
    stop_reason: row.stop_reason || "",
    status: row.status || ""
  })));
}

function updateClock() {
  if ($("headerClock")) {
    $("headerClock").textContent = new Date().toLocaleString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }
}

function setupControls() {
  if ($("ledgerSearch")) $("ledgerSearch").addEventListener("input", renderLedger);
  if ($("ledgerStatus")) $("ledgerStatus").addEventListener("change", renderLedger);

  ["eventSearch", "eventTypeFilter", "eventDateFilter"].forEach(id => {
    if ($(id)) $(id).addEventListener("input", renderEventHistory);
    if ($(id)) $(id).addEventListener("change", renderEventHistory);
  });

  if ($("exportLedgerBtn")) $("exportLedgerBtn").addEventListener("click", exportLedger);
  if ($("exportEventsBtn")) $("exportEventsBtn").addEventListener("click", exportEvents);
  if ($("exportReportBtn")) $("exportReportBtn").addEventListener("click", exportReport);

  if ($("refreshEventsBtn")) $("refreshEventsBtn").addEventListener("click", loadEvents);
  if ($("refreshShiftsBtn")) $("refreshShiftsBtn").addEventListener("click", loadShifts);
  if ($("refreshLedgerBtn")) $("refreshLedgerBtn").addEventListener("click", loadLedger);
  if ($("refreshAnalyticsBtn")) $("refreshAnalyticsBtn").addEventListener("click", loadAnalytics);
  if ($("refreshReportsBtn")) {
    $("refreshReportsBtn").addEventListener("click", async () => {
      await loadLedger();
      renderReports();
    });
  }
}

async function initialLoad() {
  setupNavigation();
  setupControls();
  updateClock();

  await loadLive();

  await Promise.all([
    loadShifts(),
    loadLedger(),
    loadAnalytics(),
    loadEvents()
  ]);

  renderReports();
}

window.showPage = showPage;
window.startShift = startShift;
window.endShift = endShift;
window.openVerification = openVerification;
window.loadShifts = loadShifts;
window.loadLedger = loadLedger;
window.loadAnalytics = loadAnalytics;
window.loadEvents = loadEvents;
window.renderLedger = renderLedger;
window.renderEventHistory = renderEventHistory;
window.renderReports = renderReports;

initialLoad();

setInterval(loadLive, 3000);
setInterval(updateClock, 15000);