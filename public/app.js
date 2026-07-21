const API_BASE = "/api";
const POLL_INTERVAL_MS = 4000;

const els = {
  statsRow: document.getElementById("statsRow"),
  dropZone: document.getElementById("dropZone"),
  fileInput: document.getElementById("fileInput"),
  uploadStatus: document.getElementById("uploadStatus"),
  issueFrequency: document.getElementById("issueFrequency"),
  imageList: document.getElementById("imageList"),
  statusFilter: document.getElementById("statusFilter"),
  refreshBtn: document.getElementById("refreshBtn"),
  detailOverlay: document.getElementById("detailOverlay"),
  detailContent: document.getElementById("detailContent"),
  closeDetail: document.getElementById("closeDetail"),
};

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- Analytics ----------
async function loadAnalytics() {
  try {
    const res = await fetch(`${API_BASE}/analytics`);
    if (!res.ok) return;
    const data = await res.json();
    renderStats(data);
    renderIssueFrequency(data.issueFrequency, data.totalCompleted);
  } catch (err) {
    console.error("Failed to load analytics", err);
  }
}

function renderStats(data) {
  const { byStatus, totalImages, duplicateRate, processingTime } = data;
  const cards = [
    { label: "Total images", value: totalImages, cls: "" },
    { label: "Completed", value: byStatus.completed, cls: "ok" },
    { label: "Processing", value: byStatus.processing, cls: "accent" },
    { label: "Failed", value: byStatus.failed, cls: "crit" },
    { label: "Duplicate rate", value: `${Math.round(duplicateRate * 100)}%`, cls: "" },
    { label: "Avg process time", value: fmtMs(processingTime.avgMs), cls: "" },
  ];
  els.statsRow.innerHTML = cards
    .map(
      (c) => `
      <div class="stat-card ${c.cls}">
        <div class="value">${c.value}</div>
        <div class="label">${c.label}</div>
      </div>`
    )
    .join("");
}

function renderIssueFrequency(issueFrequency, totalCompleted) {
  const entries = Object.entries(issueFrequency || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    els.issueFrequency.innerHTML = `<p class="empty-hint">No completed images yet.</p>`;
    return;
  }
  const max = Math.max(...entries.map(([, count]) => count));
  els.issueFrequency.innerHTML = entries
    .map(([check, count]) => {
      const pct = max ? Math.round((count / max) * 100) : 0;
      return `
        <div class="issue-bar-row">
          <span class="label">${escapeHtml(check)}</span>
          <span class="issue-bar-track"><span class="issue-bar-fill" style="width:${pct}%"></span></span>
          <span class="count">${count}</span>
        </div>`;
    })
    .join("");
}

// ---------- Image list ----------
let currentImages = [];

async function loadImages() {
  try {
    const statusParam = els.statusFilter.value ? `&status=${els.statusFilter.value}` : "";
    const res = await fetch(`${API_BASE}/images?limit=30${statusParam}`);
    if (!res.ok) return;
    const data = await res.json();
    currentImages = data.items || [];
    renderImageList(currentImages);
  } catch (err) {
    console.error("Failed to load images", err);
  }
}

function renderImageList(images) {
  if (!images.length) {
    els.imageList.innerHTML = `<p class="empty-hint">No images uploaded yet — upload one to get started.</p>`;
    return;
  }
  els.imageList.innerHTML = images
    .map((img) => {
      const issueCount = (img.issues || []).length;
      const issueLabel = issueCount === 0 && img.status === "completed" ? "no issues" : `${issueCount} issue${issueCount === 1 ? "" : "s"}`;
      return `
        <div class="image-row" data-id="${img._id || img.id}">
          <div class="tag status-${img.status}">${img.status}</div>
          <div>
            <div class="filename">${escapeHtml(img.originalFilename)}</div>
            <div class="meta">${fmtTime(img.uploadedAt)}${img.processedAt ? " → " + fmtTime(img.processedAt) : ""}</div>
          </div>
          <div class="issue-count">${img.status === "completed" ? issueLabel : ""}</div>
        </div>`;
    })
    .join("");

  els.imageList.querySelectorAll(".image-row").forEach((row) => {
    row.addEventListener("click", () => openDetail(row.dataset.id));
  });
}

// ---------- Detail view ----------
async function openDetail(id) {
  els.detailOverlay.classList.remove("hidden");
  els.detailContent.innerHTML = `<p class="empty-hint">Loading…</p>`;

  try {
    const res = await fetch(`${API_BASE}/images/${id}/results`);
    const data = await res.json();

    if (!res.ok) {
      els.detailContent.innerHTML = `
        <h3>Not ready yet</h3>
        <p class="detail-id">${id}</p>
        <p class="empty-hint">Status: ${data.status || "unknown"}. ${data.error || ""}</p>`;
      return;
    }

    const checksHtml = Object.entries(data.analysis || {})
      .map(([name, result]) => {
        const detail = result && result.error
          ? `error: ${result.error}`
          : Object.entries(result || {})
              .filter(([k]) => k !== "reasons")
              .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
              .join("\n");
        return `
          <div class="check-block">
            <div class="check-title"><span class="check-name">${escapeHtml(name)}</span></div>
            <div class="check-detail">${escapeHtml(detail)}</div>
          </div>`;
      })
      .join("");

    const issuesHtml = (data.issues || [])
      .map((i) => `<span class="tag severity-${i.severity}">${escapeHtml(i.check)}: ${escapeHtml(i.message)}</span>`)
      .join(" ");

    els.detailContent.innerHTML = `
      <h3>${escapeHtml(data.originalFilename)}</h3>
      <p class="detail-id">${data.id}</p>
      <div style="margin-bottom:16px; display:flex; flex-wrap:wrap; gap:6px;">${issuesHtml || '<span class="empty-hint">No issues flagged</span>'}</div>
      ${checksHtml}`;
  } catch (err) {
    els.detailContent.innerHTML = `<p class="empty-hint">Failed to load results: ${escapeHtml(err.message)}</p>`;
  }
}

els.closeDetail.addEventListener("click", () => els.detailOverlay.classList.add("hidden"));
els.detailOverlay.addEventListener("click", (e) => {
  if (e.target === els.detailOverlay) els.detailOverlay.classList.add("hidden");
});

// ---------- Upload ----------
async function uploadFile(file) {
  if (!file) return;
  els.uploadStatus.textContent = `Uploading ${file.name}…`;
  els.uploadStatus.className = "upload-status";

  const form = new FormData();
  form.append("image", file);

  try {
    const res = await fetch(`${API_BASE}/images`, { method: "POST", body: form });
    const data = await res.json();

    if (!res.ok) {
      els.uploadStatus.textContent = `Error: ${data.error || "upload failed"}`;
      els.uploadStatus.className = "upload-status error";
      return;
    }

    els.uploadStatus.textContent = `Accepted — id ${data.id.slice(0, 8)}… (processing)`;
    els.uploadStatus.className = "upload-status ok";
    loadImages();
    loadAnalytics();
  } catch (err) {
    els.uploadStatus.textContent = `Network error: ${err.message}`;
    els.uploadStatus.className = "upload-status error";
  }
}

els.dropZone.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", (e) => uploadFile(e.target.files[0]));

["dragenter", "dragover"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  els.dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropZone.classList.remove("drag-over");
  })
);
els.dropZone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

els.statusFilter.addEventListener("change", loadImages);
els.refreshBtn.addEventListener("click", () => {
  loadImages();
  loadAnalytics();
});

// ---------- Polling ----------
function refreshAll() {
  loadImages();
  loadAnalytics();
}

refreshAll();
setInterval(refreshAll, POLL_INTERVAL_MS);
