"use client";

import { useEffect, useState } from "react";
import type { McpServerSafe } from "@/lib/mcp-servers-types";

type EditableFields = {
  label: string;
  practice: string;
  endpoint: string;
  instance: string;
  auth: string;
  active: boolean;
  gateway: boolean;
};

function blankFields(s?: McpServerSafe): EditableFields {
  return {
    label: s?.label ?? "",
    practice: s?.practice ?? "",
    endpoint: s?.endpoint ?? "",
    instance: s?.instance ?? "",
    auth: "",
    active: s?.active ?? true,
    gateway: s?.gateway ?? false,
  };
}

/**
 * MCP servers registry + gateway, ported from Agent Manager's Settings
 * panel. Each row can be "Checked" (asks the server what it exposes),
 * signed in to via OAuth (a popup — the callback posts a message back
 * here and closes itself), or configured with a static Authorization
 * value for servers with no sign-in of their own.
 */
export function McpServersSettings() {
  const [servers, setServers] = useState<McpServerSafe[]>([]);
  const [loading, setLoading] = useState(true);
  const [admins, setAdmins] = useState<string[]>([]);
  const [selectedAdmin, setSelectedAdmin] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [fields, setFields] = useState<Record<string, EditableFields>>({});
  const [checkResult, setCheckResult] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [newId, setNewId] = useState("");
  const [newFields, setNewFields] = useState<EditableFields>(blankFields());

  async function refresh() {
    const res = await fetch("/api/mcp-servers");
    const data = await res.json().catch(() => null);
    if (res.ok) setServers(data.servers ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/admins").then((r) => r.json()),
      fetch("/api/mcp-servers").then((r) => r.json()),
    ])
      .then(([adminsData, serversData]) => {
        if (cancelled) return;
        setAdmins(adminsData.admins ?? []);
        setServers(serversData.servers ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The OAuth callback runs in a popup and posts back here when it's done,
  // rather than this page polling — see api/mcp-servers/oauth/callback.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === "mcp-oauth") refresh();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  function fieldsFor(s: McpServerSafe): EditableFields {
    return fields[s.id] ?? blankFields(s);
  }

  function setFieldsFor(id: string, patch: Partial<EditableFields>, base: McpServerSafe) {
    setFields((prev) => ({ ...prev, [id]: { ...(prev[id] ?? blankFields(base)), ...patch } }));
  }

  async function save(id: string, f: EditableFields) {
    if (!selectedAdmin) return;
    setBusy((b) => ({ ...b, [id]: true }));
    setError(null);
    try {
      const res = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adminName: selectedAdmin,
          id,
          label: f.label,
          practice: f.practice || undefined,
          endpoint: f.endpoint,
          instance: f.instance || undefined,
          auth: f.auth || undefined,
          active: f.active,
          gateway: f.gateway,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to save (HTTP ${res.status}).`);
        return;
      }
      await refresh();
      setShowAdd(false);
      setNewId("");
      setNewFields(blankFields());
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function check(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    setCheckResult((c) => ({ ...c, [id]: "" }));
    setError(null);
    try {
      const res = await fetch(`/api/mcp-servers/${id}/check`, { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setCheckResult((c) => ({ ...c, [id]: data?.error ?? `HTTP ${res.status}` }));
        return;
      }
      const count = data.tools?.length ?? 0;
      setCheckResult((c) => ({ ...c, [id]: `${count} tool${count === 1 ? "" : "s"} found.` }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  function signIn(id: string) {
    if (!selectedAdmin) return;
    const url = `/api/mcp-servers/${id}/oauth/start?adminName=${encodeURIComponent(selectedAdmin)}`;
    window.open(url, "mcp-oauth", "width=520,height=650");
  }

  async function signOut(id: string) {
    if (!selectedAdmin) return;
    setBusy((b) => ({ ...b, [id]: true }));
    setError(null);
    try {
      const res = await fetch(`/api/mcp-servers/${id}/oauth/signout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adminName: selectedAdmin }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to sign out (HTTP ${res.status}).`);
        return;
      }
      await refresh();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <h2 className="text-sm font-semibold text-black dark:text-zinc-50">MCP servers</h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        Adobe ships one MCP per product — Workfront, AEM, AEP — and more will arrive. Each is an entry here, never a
        branch in code. <b>Check</b> asks a server what it actually exposes. <b>Sign in</b> discovers the server&apos;s
        own OAuth provider and opens its login page — no token pasted anywhere, and it&apos;s never sent back to this
        page, only whether one is set. <b>Expose to Claude</b> re-exposes a server&apos;s tools through this harness&apos;s
        own <code className="text-xs">/api/mcp</code> endpoint, namespaced by server id, to whatever connects there.
      </p>

      <div className="mt-3 flex items-center gap-2 text-sm">
        <select
          className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
          value={selectedAdmin}
          onChange={(e) => setSelectedAdmin(e.target.value)}
        >
          <option value="">Sign as…</option>
          {admins.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <span className="text-xs text-zinc-400">required to save, sign in/out, or register a server</span>
      </div>

      {loading && <p className="mt-3 text-xs text-zinc-400">Loading…</p>}
      {!loading && servers.length === 0 && !showAdd && <p className="mt-3 text-xs text-zinc-400">No MCP servers registered.</p>}

      <div className="mt-3 flex flex-col gap-3">
        {servers.map((s) => {
          const f = fieldsFor(s);
          const isOpen = !!expanded[s.id];
          return (
            <div key={s.id} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${s.active ? "bg-green-500" : "bg-zinc-300 dark:bg-zinc-700"}`} />
                <b className="text-black dark:text-zinc-50">{s.label}</b>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{s.id}</span>
                {s.practice && <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{s.practice}</span>}
                {s.oauth_connected ? (
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800 dark:bg-green-950 dark:text-green-400">authenticated</span>
                ) : s.auth_configured ? (
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">credential set</span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-400">no credential</span>
                )}
                {s.gateway && <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-800 dark:bg-purple-950 dark:text-purple-400">to Claude</span>}
                <span className="grow" />
                {s.oauth_connected ? (
                  <button
                    onClick={() => signOut(s.id)}
                    disabled={busy[s.id] || !selectedAdmin}
                    className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                  >
                    Sign out
                  </button>
                ) : s.endpoint ? (
                  <button
                    onClick={() => signIn(s.id)}
                    disabled={!selectedAdmin}
                    className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
                  >
                    Sign in
                  </button>
                ) : null}
                <button
                  onClick={() => check(s.id)}
                  disabled={busy[s.id]}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300"
                >
                  Check
                </button>
                <button
                  onClick={() => setExpanded((e) => ({ ...e, [s.id]: !e[s.id] }))}
                  className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
                >
                  {isOpen ? "Hide" : "Configure"}
                </button>
              </div>

              <p className="mt-1 ml-4 font-mono text-xs text-zinc-400">{s.endpoint || "no endpoint set"}</p>
              {checkResult[s.id] && <p className="mt-1 ml-4 text-xs text-zinc-500 dark:text-zinc-400">{checkResult[s.id]}</p>}

              {isOpen && (
                <div className="mt-3 flex flex-col gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-900">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">Name</span>
                      <input
                        className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        value={f.label}
                        onChange={(e) => setFieldsFor(s.id, { label: e.target.value }, s)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">Domain</span>
                      <input
                        className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        placeholder="workfront | aep | aem"
                        value={f.practice}
                        onChange={(e) => setFieldsFor(s.id, { practice: e.target.value }, s)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs sm:col-span-2">
                      <span className="text-zinc-500 dark:text-zinc-400">Endpoint URL</span>
                      <input
                        className="rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        value={f.endpoint}
                        onChange={(e) => setFieldsFor(s.id, { endpoint: e.target.value }, s)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">Instance</span>
                      <input
                        className="rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        placeholder="tenant, where one is needed"
                        value={f.instance}
                        onChange={(e) => setFieldsFor(s.id, { instance: e.target.value }, s)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      <span className="text-zinc-500 dark:text-zinc-400">Authorization (only if the server has no sign-in)</span>
                      <input
                        type="password"
                        autoComplete="off"
                        className="rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                        placeholder="leave blank to keep what is stored"
                        value={f.auth}
                        onChange={(e) => setFieldsFor(s.id, { auth: e.target.value }, s)}
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" checked={f.active} onChange={(e) => setFieldsFor(s.id, { active: e.target.checked }, s)} />
                      Active
                    </label>
                    <label className="flex items-center gap-1.5 text-xs" title="Re-exposes this server's own tools through this harness's /api/mcp endpoint">
                      <input type="checkbox" checked={f.gateway} onChange={(e) => setFieldsFor(s.id, { gateway: e.target.checked }, s)} />
                      Expose its tools to Claude
                    </label>
                    <button
                      onClick={() => save(s.id, f)}
                      disabled={busy[s.id] || !selectedAdmin}
                      className="rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
                    >
                      {busy[s.id] ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showAdd ? (
        <div className="mt-3 flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-zinc-500 dark:text-zinc-400">ID (stable, e.g. workfront-adobe)</span>
              <input
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-zinc-500 dark:text-zinc-400">Name</span>
              <input
                className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                value={newFields.label}
                onChange={(e) => setNewFields((f) => ({ ...f, label: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs sm:col-span-2">
              <span className="text-zinc-500 dark:text-zinc-400">Endpoint URL</span>
              <input
                className="rounded border border-zinc-300 bg-white px-2 py-1 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
                value={newFields.endpoint}
                onChange={(e) => setNewFields((f) => ({ ...f, endpoint: e.target.value }))}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => save(newId.trim(), newFields)}
              disabled={!selectedAdmin || !newId.trim() || !/^[a-zA-Z0-9_-]+$/.test(newId.trim()) || !newFields.label.trim()}
              className="rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
            >
              Register
            </button>
            <button
              onClick={() => {
                setShowAdd(false);
                setNewId("");
                setNewFields(blankFields());
              }}
              className="rounded-full border border-zinc-300 px-4 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="mt-3 rounded-full border border-zinc-300 px-4 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:text-zinc-300"
        >
          + Add an MCP server
        </button>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}
