import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { ChatCircleDots } from "@phosphor-icons/react";
import { useAuth } from "../auth/useAuth";

interface Props {
  headline: string;
  stepIndex: number;
  total: number;
  children: ReactNode;
}

export function SetupLayout({ headline, stepIndex, total, children }: Props) {
  const { logout } = useAuth();
  return (
    <div className="setup-root">
      <div className="setup-left">
        <div className="setup-assistant">
          <span className="setup-assistant-avatar">
            <ChatCircleDots size={22} weight="fill" />
          </span>
          <span>
            <div className="setup-assistant-name">Tailrd Assistant</div>
            <div className="setup-assistant-sub">Your AI job copilot</div>
          </span>
        </div>
        <motion.h1
          key={headline}
          className="setup-headline setup-anim"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
          dangerouslySetInnerHTML={{ __html: headline }}
        />
      </div>
      <div className="setup-right">
        <button className="setup-logout" onClick={logout}>Logout</button>
        <div className="setup-dots" aria-label={`Step ${stepIndex + 1} of ${total}`}>
          {Array.from({ length: total }).map((_, i) => (
            <span key={i} className={`setup-dot${i === stepIndex ? " active" : i < stepIndex ? " done" : ""}`} />
          ))}
        </div>
        <motion.div
          key={stepIndex}
          className="setup-form setup-anim"
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.22 }}
        >
          {children}
        </motion.div>
      </div>
    </div>
  );
}
