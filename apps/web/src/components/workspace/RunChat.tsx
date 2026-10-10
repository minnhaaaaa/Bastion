import { ResponseMarkdown } from "./ResponseMarkdown";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { Bot, ShieldAlert, Activity } from "lucide-react";
import type { RunEvent, RunSnapshot } from "@bastion/contracts";
import { api } from "../../lib/api";
import { chatArtifacts, progressMessage } from "../../lib/chat-evidence";
import { ErrorBox } from "../ui";

gsap.registerPlugin(useGSAP);

function Progress({ message }: { message: string }) {
  const element = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add({ reduce: "(prefers-reduced-motion: reduce)", animate: "(prefers-reduced-motion: no-preference)" }, context => {
      if (context.conditions?.reduce) return;
      gsap.timeline().fromTo(element.current, { autoAlpha: 0, y: 4 }, { autoAlpha: 1, y: 0, duration: .2 }).to(element.current, { autoAlpha: 0, duration: .25, delay: 3 });
    });
    return () => media.revert();
  }, { scope: element });
  return <div ref={element} className="chat-progress" role="status"><Activity aria-hidden="true" />{message}</div>;
}

function TypedResponse({ content, animate }: { content: string; animate: boolean }) {
  const text = useRef<HTMLDivElement>(null);
  const tween = useRef<gsap.core.Tween | null>(null);
  const [typing, setTyping] = useState(false);
  useGSAP(() => {
    const media = gsap.matchMedia();
    media.add({ reduce: "(prefers-reduced-motion: reduce)", animate: "(prefers-reduced-motion: no-preference)" }, context => {
      if (!text.current) return;
      const walker = document.createTreeWalker(text.current, NodeFilter.SHOW_TEXT);
      const nodes: { node: Text; characters: string[] }[] = [];
      while (walker.nextNode()) nodes.push({ node: walker.currentNode as Text, characters: Array.from(walker.currentNode.textContent ?? "") });
      const total = nodes.reduce((sum, item) => sum + item.characters.length, 0);
      const reveal = (count: number) => { for (const item of nodes) { item.node.textContent = item.characters.slice(0, Math.max(0, count)).join(""); count -= item.characters.length; } };
      if (!animate || context.conditions?.reduce) { reveal(total); setTyping(false); return; }
      const cursor = { count: 0 };
      reveal(0); setTyping(true);
      tween.current = gsap.to(cursor, { count: total, duration: Math.min(5, Math.max(.4, total / 180)), ease: "none", onUpdate: () => reveal(Math.floor(cursor.count)), onComplete: () => { reveal(total); setTyping(false); } });
      return () => reveal(total);
    });
    return () => media.revert();
  }, { dependencies: [content, animate], scope: text, revertOnUpdate: true });
  return <><div ref={text} aria-live="off" className={`chat-response-text ${typing ? "is-typing" : ""}`}><ResponseMarkdown content={content} /></div>{typing && <button type="button" className="desk-subtle" onClick={() => { tween.current?.progress(1).kill(); setTyping(false); }}>Show full response</button>}</>;
}

function Response({ snapshot, artifact, token, animate }: { snapshot: RunSnapshot; artifact: ReturnType<typeof chatArtifacts>[number]; token: string; animate: boolean }) {
  const usable = artifact.trustState === "CLEAR" && snapshot.executions[artifact.producerExecutionId]?.securityState === "CLEAR";
  const output = useQuery({ queryKey: ["artifact-content", snapshot.run.id, artifact.id, artifact.trustState, token], queryFn: () => api<{ content: string }>(`/api/runs/${snapshot.run.id}/artifacts/${artifact.id}/content`, token), enabled: usable });
  return <article className="chat-response"><header><Bot aria-hidden="true" /><strong>{artifact.name}</strong><small>{artifact.trustState}</small></header>{!usable ? <p className="chat-warning">This output has been invalidated. Review Security before using it.</p> : <><ErrorBox error={output.error} />{output.isPending ? <p role="status" className="desk-hint">Loading response…</p> : output.data && <TypedResponse content={output.data.content} animate={animate} />}</>}<footer>Version {artifact.version} · {artifact.classification} · Sensitive patterns redacted</footer></article>;
}

export function RunChat({ snapshot, events, token, prompt, onInspect }: { snapshot: RunSnapshot; events: RunEvent[]; token: string; prompt?: string; onInspect(view: "security" | "activity"): void }) {
  const existing = useRef(new Set(Object.keys(snapshot.artifacts)));
  const last = [...events].reverse().find(event => progressMessage(event));
  const incidents = Object.values(snapshot.incidents).filter(incident => incident.state !== "RESOLVED");
  const denied = Object.values(snapshot.toolRequests).filter(tool => tool.decision === "DENY");
  const outputs = chatArtifacts(snapshot);
  return <div className="run-chat">
    {prompt && <div className="chat-user"><span>You</span><p>{prompt}</p></div>}
    {last && <Progress key={last.eventId} message={progressMessage(last)!} />}
    {(incidents.length > 0 || denied.length > 0 || snapshot.run.status === "FAILED") && <div className="chat-warning" role="status"><ShieldAlert aria-hidden="true" /><span>{incidents.length ? `${incidents.length} security incident${incidents.length === 1 ? "" : "s"} recorded.` : denied.length ? `${denied.length} action${denied.length === 1 ? "" : "s"} blocked.` : "This run stopped before completion."}</span><button className="desk-subtle" onClick={() => onInspect(incidents.length || denied.length ? "security" : "activity")}>Review details</button></div>}
    {outputs.map(artifact => <Response key={artifact.id} snapshot={snapshot} artifact={artifact} token={token} animate={!existing.current.has(artifact.id)} />)}
    {!outputs.length && <p className="chat-waiting">{["COMPLETED", "RECOVERED", "FAILED"].includes(snapshot.run.status) ? "No final response was recorded. Open Activity to inspect the run." : "The response will appear here when it is ready."}</p>}
  </div>;
}
