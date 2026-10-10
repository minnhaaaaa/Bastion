import { useId, useState, type ReactNode } from "react";

/** Details start collapsed and change only when their title is activated. */
export function DetailDisclosure({ title, children, className = "" }: { title: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <section className={`desk-details ${className}`}>
    <button type="button" className="desk-detail-title" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      <span>{title}</span><span aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    <div id={id} className="desk-detail-content" hidden={!open}>{open && children}</div>
  </section>;
}
