"use client";

import { useEffect, useState } from "react";
import styles from "../lecture-translator/lecture-translator.module.css";
import type { SignedInUser } from "../lecture-translator/auth-panel";

type AdminUser = SignedInUser & { status: "active" | "disabled"; createdAt: string; lastLoginAt: string | null };

export default function AdminPage() {
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invite, setInvite] = useState("");
  const [notice, setNotice] = useState("Loading…");

  const load = async () => {
    const session = await fetch("/api/auth/session", { cache: "no-store" }).then((response) => response.json()).catch(() => ({})) as { user?: SignedInUser | null };
    setUser(session.user || null);
    if (session.user?.role !== "admin") { setNotice(session.user ? "只有管理员可以访问这里。" : "请先登录管理员账号。"); return; }
    const result = await fetch("/api/auth/users", { cache: "no-store" }).then((response) => response.json()).catch(() => ({})) as { users?: AdminUser[]; error?: string };
    setUsers(result.users || []);
    setNotice(result.error || "");
  };
  useEffect(() => { void load(); }, []);

  const makeInvite = async () => {
    const response = await fetch("/api/auth/invites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ days: 30 }) });
    const result = await response.json().catch(() => ({})) as { code?: string; error?: string };
    if (!response.ok || !result.code) { setNotice(result.error || "无法生成邀请码。"); return; }
    setInvite(result.code);
    await navigator.clipboard?.writeText(result.code).catch(() => undefined);
    setNotice("邀请码已复制，有效期 30 天且只能使用一次。");
  };

  const updateUser = async (target: AdminUser, values: Record<string, unknown>) => {
    const response = await fetch("/api/auth/users", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: target.id, ...values }) });
    if (!response.ok) { const result = await response.json().catch(() => ({})) as { error?: string }; setNotice(result.error || "更新失败。"); return; }
    await load();
  };

  if (!user || user.role !== "admin") return <main className={styles.authShell}><iframe className={styles.brandOrbsBackground} src="/backgrounds/brand-orbs-codex.html" title="" aria-hidden="true" /><section className={styles.authCard}><h1>{notice}</h1><p className={styles.authIntro}>请使用管理员账号登录后再打开此页面。</p><a className={styles.authSubmit} href="/lecture-translator">返回登录</a></section></main>;
  return <main className={styles.adminShell}><iframe className={styles.brandOrbsBackground} src="/backgrounds/brand-orbs-codex.html" title="" aria-hidden="true" />
    <header className={styles.adminHeader}><div><p className={styles.authEyebrow}>Lecture Translator</p><h1>Admin console</h1><p>创建邀请码、管理用户和 API 月度额度。</p></div><a href="/lecture-translator">返回课堂</a></header>
    <section className={styles.adminSection}><div className={styles.adminSectionHead}><div><h2>Invite a user</h2><p>每个邀请码只能注册一次，默认每月 100,000 token。</p></div><button className={styles.authSubmit} onClick={() => void makeInvite()}>生成邀请码</button></div>{invite ? <code className={styles.inviteCode}>{invite}</code> : null}{notice ? <p className={styles.adminNotice}>{notice}</p> : null}</section>
    <section className={styles.adminSection}><div className={styles.adminSectionHead}><div><h2>Users</h2><p>停用账号后，翻译、笔记和 AI 辅助都会立即停止。</p></div></div><div className={styles.userTable}>{users.map((target) => <div className={styles.userRow} key={target.id}><div><strong>{target.displayName}</strong><small>{target.phone} · {target.role === "admin" ? "Administrator" : "User"}</small></div><label>月额度<input type="number" min={1000} max={10000000} defaultValue={target.monthlyTokenLimit} onBlur={(event) => void updateUser(target, { monthlyTokenLimit: Number(event.target.value) })} /></label><button onClick={() => void updateUser(target, { status: target.status === "active" ? "disabled" : "active" })}>{target.status === "active" ? "停用" : "启用"}</button></div>)}</div></section>
  </main>;
}
