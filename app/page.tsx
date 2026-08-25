"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Category = "卧室" | "洗手间" | "厨房" | "其他" | "学习用品" | "重要文件" | "自定义";
type Filter = "全部" | "待准备" | "已完成";
type ChecklistItem = { id: string; title: string; category: Category; done: boolean };

const storageKey = "travel-prep-checklist-v2";
const starterItems: ChecklistItem[] = [
  ...["针线", "被子", "被套（两床）", "枕套", "枕头", "四季衣物", "袜子", "内裤", "鞋子", "花洒", "拖鞋"].map((title, index) => ({ id: `bedroom-${index + 1}`, title, category: "卧室" as const, done: false })),
  ...["毛巾", "浴巾", "晾衣架", "绳", "牙刷", "牙膏", "吹风机", "洗头膏", "沐浴液", "湿巾", "纸巾", "沐浴包"].map((title, index) => ({ id: `bathroom-${index + 1}`, title, category: "洗手间" as const, done: false })),
  ...["小绿锅", "炒菜锅", "勺", "炒菜铲", "面板垫", "调味料", "擀面杖", "酵母", "丝瓜刷（刷碗）", "净水龙头", "筷子", "碗", "菜板"].map((title, index) => ({ id: `kitchen-${index + 1}`, title, category: "厨房" as const, done: false })),
  ...["眼镜", "牙疼药", "腹泻药", "感冒药", "创可贴", "消毒棉棒", "罗红霉素", "编织袋", "5号电池", "7号电池", "U盘", "小风扇", "艾灸盒", "西装", "护颈枕", "扑克", "五金套装", "防风伞"].map((title, index) => ({ id: `other-${index + 1}`, title, category: "其他" as const, done: false })),
  ...["笔", "本", "电脑", "备用手机", "充电插排", "转换插头"].map((title, index) => ({ id: `study-${index + 1}`, title, category: "学习用品" as const, done: false })),
  { id: "important-documents-1", title: "签证报到所有文件", category: "重要文件", done: false },
];
const categories: Category[] = ["卧室", "洗手间", "厨房", "其他", "学习用品", "重要文件", "自定义"];

function DocumentMark() { return <svg aria-hidden="true" viewBox="0 0 48 48" fill="none"><path d="M12 5h18l8 8v30H12z" stroke="currentColor" strokeWidth="2"/><path d="M30 5v9h8M18 22h14M18 29h14M18 36h9" stroke="currentColor" strokeWidth="2"/></svg>; }
function CheckMark() { return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none"><path d="m3 8.5 3 3L13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter"/></svg>; }
function DeleteMark() { return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none"><path d="M4 6h12M8 6V3h4v3m-7 0 1 11h8l1-11M8 9v5m4-5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"/></svg>; }

export default function Home() {
  const [items, setItems] = useState(starterItems);
  const [filter, setFilter] = useState<Filter>("全部");
  const [newItem, setNewItem] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [storageMessage, setStorageMessage] = useState("");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = window.localStorage.getItem(storageKey);
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.every((item) => item && typeof item.id === "string" && typeof item.title === "string" && categories.includes(item.category) && typeof item.done === "boolean")) setItems(parsed as ChecklistItem[]);
        }
      } catch {
        setStorageMessage("无法读取本地保存，已使用预设清单；请保持此页面开启。");
      }
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    const frame = window.requestAnimationFrame(() => {
      try { window.localStorage.setItem(storageKey, JSON.stringify(items)); }
      catch { setStorageMessage("无法使用本地保存，请保持此页面开启。"); }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [items, hydrated]);

  const completed = items.filter((item) => item.done).length;
  const visibleItems = useMemo(() => items.filter((item) => filter === "全部" || (filter === "已完成" ? item.done : !item.done)), [filter, items]);
  const toggleItem = (id: string) => setItems((current) => current.map((item) => item.id === id ? { ...item, done: !item.done } : item));
  const deleteItem = (id: string) => setItems((current) => current.filter((item) => item.id !== id));
  function addItem(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const title = newItem.trim(); if (!title) return; setItems((current) => [...current, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title, category: "自定义", done: false }]); setNewItem(""); }

  return <main className="travel-desk">
    <div className="paper-sheet">
      <header className="folio-head"><div className="folio-symbol"><DocumentMark /></div><div><h1>出境准备清单</h1><p className="intro">你的出境清单，可继续添加。把临行前的琐事，收进这一份资料夹。</p></div></header>
      <section className="summary" aria-label="清单进度"><div><strong>{completed}<span>/{items.length || 0}</span></strong><p>已完成</p></div><div><strong>{Math.max(items.length - completed, 0)}</strong><p>待准备</p></div><div className="stamp" aria-label={completed === items.length && items.length ? "清单已完成" : "准备中"}>{completed === items.length && items.length ? "READY" : "IN PREP"}</div></section>
      <form className="add-form" onSubmit={addItem}><label htmlFor="new-checklist-item">新增事项</label><div className="add-row"><input id="new-checklist-item" value={newItem} onChange={(event) => setNewItem(event.target.value)} placeholder="例如：确认机场接送安排" maxLength={80} /><button type="submit" disabled={!newItem.trim()}>加入清单</button></div></form>
      <nav className="filters" aria-label="筛选清单">{(["全部", "待准备", "已完成"] as Filter[]).map((option) => <button key={option} type="button" className={filter === option ? "active" : ""} aria-pressed={filter === option} onClick={() => setFilter(option)}>{option}</button>)}</nav>
      <section className="checklist" aria-live="polite" aria-label={`${filter}事项`}>
        {visibleItems.length ? categories.map((category) => { const categoryItems = visibleItems.filter((item) => item.category === category); if (!categoryItems.length) return null; return <div className="category-group" key={category}><h2>{category}<span>{categoryItems.length}</span></h2><ul>{categoryItems.map((item) => <li className={item.done ? "done" : ""} key={item.id}><button className="check-button" type="button" aria-label={`${item.done ? "取消完成" : "标记完成"}：${item.title}`} aria-pressed={item.done} onClick={() => toggleItem(item.id)}><CheckMark /></button><span>{item.title}</span><button className="delete-button" type="button" aria-label={`删除：${item.title}`} onClick={() => deleteItem(item.id)}><DeleteMark /></button></li>)}</ul></div>; }) : <div className="empty-state"><DocumentMark /><h2>这里暂时没有事项</h2><p>切换筛选条件，或在上方加入一条新的准备事项。</p></div>}
      </section>
    </div>
    {storageMessage && <p className="storage-status" role="status">{storageMessage}</p>}
    <footer>资料夹会自动保存在这台设备上{hydrated ? "" : " · 正在读取"}</footer>
  </main>;
}
