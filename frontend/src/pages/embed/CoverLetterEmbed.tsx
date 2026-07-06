import { useEffect, useMemo, useRef, useState } from "react";
import CoverLetterModal from "../../components/CoverLetterModal";
import type { AIJob } from "../../components/CustomResumeModal";
import { createEmbedBridge, createEmbedAxios, type EmbedJob } from "./embedApi";

/**
 * Full-bleed host for the real CoverLetterModal, framed by the extension.
 * generate hits the existing context-keyed /api/cover-letter; "Attach to
 * application" renders the letter to PDF and hands the bytes to the parent.
 * Save is hidden (no DB job_id to save under from a live application page).
 */
export default function CoverLetterEmbed() {
  const bridge = useMemo(() => createEmbedBridge(), []);
  const api = useMemo(() => createEmbedAxios(bridge.getToken, bridge.requestFreshToken), [bridge]);
  const [ctx, setCtx] = useState<EmbedJob | null>(null);
  const lastText = useRef("");

  useEffect(() => {
    bridge.ready.then(({ job }) => setCtx(job));
  }, [bridge]);

  if (!ctx) {
    return <div className="ai-loading"><div className="ai-spinner" /></div>;
  }

  const job: AIJob = { title: ctx.title, company: ctx.company, url: ctx.url };

  const generate = (rid: number | null, tone?: string, base?: string) =>
    api
      .post("/api/cover-letter", {
        resume_id: rid,
        job_title: ctx.title,
        company: ctx.company,
        job_description: ctx.description,
        tone: tone?.toLowerCase() ?? null,
        base_text: base ?? null,
      })
      .then((r) => {
        lastText.current = (r.data.text as string) ?? "";
        return { text: lastText.current };
      });

  const onAttach = async () => {
    if (!lastText.current) return;
    const slug = ctx.company.toLowerCase().replace(/\s+/g, "-") || "company";
    const res = await api.post("/api/render-cover-letter", {
      text: lastText.current,
      filename: `cover-letter-${slug}.pdf`,
    });
    bridge.attach("cover", {
      dataBase64: res.data.data_base64,
      filename: res.data.name,
      contentType: res.data.content_type ?? "application/pdf",
    });
  };

  return (
    <CoverLetterModal
      job={job}
      onClose={bridge.close}
      generate={generate}
      canSave={false}
      onAttach={onAttach}
    />
  );
}
