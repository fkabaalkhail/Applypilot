import { useEffect, useMemo, useRef, useState } from "react";
import CustomResumeModal, { type AIJob } from "../../components/CustomResumeModal";
import type { ResumeDocument } from "../../lib/resumeDocument";
import { createEmbedBridge, createEmbedAxios, type EmbedJob } from "./embedApi";

/**
 * Full-bleed host for the real CustomResumeModal, framed by the extension.
 * Job context + auth token arrive from the parent over a MessageChannel; the
 * modal's analyze/generate hit the context-keyed /api/* endpoints, and "Attach
 * to application" renders the edited document to a PDF handed back to the parent.
 */
export default function CustomResumeEmbed() {
  const bridge = useMemo(() => createEmbedBridge(), []);
  const api = useMemo(() => createEmbedAxios(bridge.getToken, bridge.requestFreshToken), [bridge]);
  const [ctx, setCtx] = useState<EmbedJob | null>(null);
  // Latest generated document — used by onAttach to render the PDF bytes.
  const lastDoc = useRef<ResumeDocument | null>(null);

  useEffect(() => {
    bridge.ready.then(({ job }) => setCtx(job));
  }, [bridge]);

  if (!ctx) {
    return <div className="ai-loading"><div className="ai-spinner" /></div>;
  }

  const job: AIJob = { title: ctx.title, company: ctx.company, url: ctx.url };

  const analyze = (rid: number | null) =>
    api
      .post("/api/custom-resume-analysis", {
        resume_id: rid,
        job_title: ctx.title,
        company: ctx.company,
        job_description: ctx.description,
      })
      .then((r) => r.data);

  const generate = (rid: number | null, sections: string[], keywords: string[]) =>
    api
      .post("/api/custom-resume", {
        resume_id: rid,
        job_title: ctx.title,
        company: ctx.company,
        job_description: ctx.description,
        sections,
        add_keywords: keywords,
      })
      .then((r) => {
        lastDoc.current = r.data.document as ResumeDocument;
        return r.data;
      });

  const onAttach = async () => {
    const doc = lastDoc.current;
    if (!doc) return;
    const slug = ctx.company.toLowerCase().replace(/\s+/g, "-") || "company";
    const res = await api.post("/api/render-resume", { document: doc, filename: `resume-${slug}.pdf` });
    bridge.attach("resume", {
      dataBase64: res.data.data_base64,
      filename: res.data.name,
      contentType: res.data.content_type ?? "application/pdf",
    });
  };

  return (
    <CustomResumeModal
      job={job}
      onClose={bridge.close}
      analyze={analyze}
      generate={generate}
      jobId={null}
      onAttach={onAttach}
      apiClient={api}
    />
  );
}
