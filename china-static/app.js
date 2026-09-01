(() => {
  "use strict";

  const storageKey = "travel-prep-checklist-cn-v1";
  const categories = ["卧室", "洗手间", "厨房", "其他", "学习用品", "重要文件", "自定义"];
  const starterItems = [
    ...["针线", "被子", "被套（两床）", "枕套", "枕头", "四季衣物", "袜子", "内裤", "鞋子", "花洒", "拖鞋"].map((title, index) => ({ id: `bedroom-${index + 1}`, title, category: "卧室", done: false })),
    ...["毛巾", "浴巾", "晾衣架", "绳", "牙刷", "牙膏", "吹风机", "洗头膏", "沐浴液", "湿巾", "纸巾", "沐浴包"].map((title, index) => ({ id: `bathroom-${index + 1}`, title, category: "洗手间", done: false })),
    ...["小绿锅", "炒菜锅", "勺", "炒菜铲", "面板垫", "调味料", "擀面杖", "酵母", "丝瓜刷（刷碗）", "净水龙头", "筷子", "碗", "菜板"].map((title, index) => ({ id: `kitchen-${index + 1}`, title, category: "厨房", done: false })),
    ...["眼镜", "牙疼药", "腹泻药", "感冒药", "创可贴", "消毒棉棒", "罗红霉素", "编织袋", "5号电池", "7号电池", "U盘", "小风扇", "艾灸盒", "西装", "护颈枕", "扑克", "五金套装", "防风伞"].map((title, index) => ({ id: `other-${index + 1}`, title, category: "其他", done: false })),
    ...["笔", "本", "电脑", "备用手机", "充电插排", "转换插头"].map((title, index) => ({ id: `study-${index + 1}`, title, category: "学习用品", done: false })),
    { id: "important-documents-1", title: "签证报到所有文件", category: "重要文件", done: false },
  ];

  const checklist = document.querySelector("#checklist");
  const form = document.querySelector("#add-form");
  const input = document.querySelector("#new-checklist-item");
  const addButton = form.querySelector("button");
  const status = document.querySelector("#storage-status");
  const footer = document.querySelector("#footer-status");
  let items = starterItems;
  let filter = "全部";
  let hydrated = false;

  const documentMark = '<svg aria-hidden="true" viewBox="0 0 48 48" fill="none"><path d="M12 5h18l8 8v30H12z" stroke="currentColor" stroke-width="2"/><path d="M30 5v9h8M18 22h14M18 29h14M18 36h9" stroke="currentColor" stroke-width="2"/></svg>';
  const checkMark = '<svg aria-hidden="true" viewBox="0 0 16 16" fill="none"><path d="m3 8.5 3 3L13 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter"/></svg>';
  const deleteMark = '<svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M4 6h12M8 6V3h4v3m-7 0 1 11h8l1-11M8 9v5m4-5v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg>';

  function isValidItem(item) {
    return item && typeof item.id === "string" && typeof item.title === "string" && categories.includes(item.category) && typeof item.done === "boolean";
  }
  function showStorageNotice(message) {
    status.textContent = message;
    status.hidden = false;
  }
  function save() {
    if (!hydrated) return;
    try { localStorage.setItem(storageKey, JSON.stringify(items)); }
    catch { showStorageNotice("无法使用本地保存，请保持此页面开启。"); }
  }
  function updateSummary() {
    const completed = items.filter((item) => item.done).length;
    document.querySelector("#completed-count").firstChild.nodeValue = String(completed);
    document.querySelector("#total-count").textContent = `/${items.length}`;
    document.querySelector("#remaining-count").textContent = String(Math.max(items.length - completed, 0));
    const stamp = document.querySelector("#stamp");
    const ready = completed === items.length && items.length > 0;
    stamp.textContent = ready ? "READY" : "IN PREP";
    stamp.setAttribute("aria-label", ready ? "清单已完成" : "准备中");
  }
  function render() {
    updateSummary();
    const visible = items.filter((item) => filter === "全部" || (filter === "已完成" ? item.done : !item.done));
    checklist.setAttribute("aria-label", `${filter}事项`);
    if (!visible.length) {
      checklist.innerHTML = `<div class="empty-state">${documentMark}<h2>这里暂时没有事项</h2><p>切换筛选条件，或在上方加入一条新的准备事项。</p></div>`;
      return;
    }
    checklist.replaceChildren(...categories.map((category) => {
      const groupItems = visible.filter((item) => item.category === category);
      if (!groupItems.length) return null;
      const group = document.createElement("div");
      group.className = "category-group";
      group.innerHTML = `<h2>${category}<span>${groupItems.length}</span></h2>`;
      const list = document.createElement("ul");
      groupItems.forEach((item) => {
        const row = document.createElement("li");
        if (item.done) row.className = "done";
        const toggle = document.createElement("button");
        toggle.className = "check-button";
        toggle.type = "button";
        toggle.setAttribute("aria-label", `${item.done ? "取消完成" : "标记完成"}：${item.title}`);
        toggle.setAttribute("aria-pressed", String(item.done));
        toggle.innerHTML = checkMark;
        toggle.addEventListener("click", () => { items = items.map((entry) => entry.id === item.id ? { ...entry, done: !entry.done } : entry); save(); render(); });
        const title = document.createElement("span");
        title.textContent = item.title;
        const remove = document.createElement("button");
        remove.className = "delete-button";
        remove.type = "button";
        remove.setAttribute("aria-label", `删除：${item.title}`);
        remove.innerHTML = deleteMark;
        remove.addEventListener("click", () => { items = items.filter((entry) => entry.id !== item.id); save(); render(); });
        row.append(toggle, title, remove);
        list.append(row);
      });
      group.append(list);
      return group;
    }).filter(Boolean));
  }
  function setFilter(nextFilter) {
    filter = nextFilter;
    document.querySelectorAll("[data-filter]").forEach((button) => {
      const active = button.dataset.filter === filter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    render();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    items = [...items, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title, category: "自定义", done: false }];
    input.value = "";
    addButton.disabled = true;
    save();
    render();
  });
  input.addEventListener("input", () => { addButton.disabled = !input.value.trim(); });
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter)));

  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.every(isValidItem)) items = parsed;
    }
  } catch { showStorageNotice("无法读取本地保存，已使用预设清单；请保持此页面开启。"); }
  hydrated = true;
  footer.textContent = "资料夹会自动保存在这台设备上";
  render();
})();
