"use client";

import { FormEvent, useState } from "react";
import styles from "./lecture-translator.module.css";

export type SignedInUser = { id: string; phone: string; displayName: string; role: "admin" | "user"; monthlyTokenLimit: number };

export function AuthPanel({ onAuthenticated }: { onAuthenticated(user: SignedInUser): void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setNotice("");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, password, invite, displayName }),
      });
      const result = await response.json().catch(() => ({})) as { user?: SignedInUser; error?: string };
      if (!response.ok || !result.user) throw new Error(result.error || "暂时无法完成操作。");
      onAuthenticated(result.user);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "暂时无法完成操作。");
    } finally {
      setLoading(false);
    }
  };

  return <main className={styles.authShell}><iframe className={styles.brandOrbsBackground} src="/backgrounds/brand-orbs-codex.html" title="" aria-hidden="true" />
    <section className={styles.authCard} aria-labelledby="auth-title">
      <div className={styles.authMark} aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M5 16c3-7 7-7 11 0s8 7 11 0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /><path d="M5 22c3-7 7-7 11 0s8 7 11 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity=".55" /></svg></div>
      <p className={styles.authEyebrow}>Lecture Translator</p>
      <h1 id="auth-title">{mode === "login" ? "Welcome back" : "Join your lecture space"}</h1>
      <p className={styles.authIntro}>{mode === "login" ? "登录后继续你的课堂记录。" : "使用管理员发放的邀请码创建账号。"}</p>
      <form onSubmit={submit} className={styles.authForm}>
        <label>手机号<input inputMode="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+86 187…" required /></label>
        <label>密码<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 8 位" minLength={8} required /></label>
        {mode === "register" ? <>
          <label>邀请码<input autoCapitalize="characters" value={invite} onChange={(event) => setInvite(event.target.value.toUpperCase())} placeholder="LT-XXXXXXXXXX" required /></label>
          <label>显示名称<span className={styles.optional}>可选</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如：Chen" maxLength={80} /></label>
        </> : null}
        {notice ? <p className={styles.authError} role="alert">{notice}</p> : null}
        <button className={styles.authSubmit} disabled={loading}>{loading ? "请稍候…" : mode === "login" ? "登录" : "创建账号"}</button>
      </form>
      <button className={styles.authSwitch} type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setNotice(""); }}>{mode === "login" ? "有邀请码？创建账号" : "已有账号？返回登录"}</button>
    </section>
  </main>;
}
