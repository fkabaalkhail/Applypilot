import { useState } from "react";
import { useUser } from "@clerk/clerk-react";

export default function Refer() {
  const { user } = useUser();
  const [copied, setCopied] = useState(false);

  // Generate referral link from user ID
  const referralCode = user?.id?.slice(-8) || "tailrd";
  const referralLink = `https://www.tailrd.ca?ref=${referralCode}`;

  const copyLink = () => {
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shareLinkedIn = () => {
    window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(referralLink)}`, "_blank");
  };

  const shareTwitter = () => {
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent("Check out Tailrd - AI-powered job search for interns and new grads!")}&url=${encodeURIComponent(referralLink)}`, "_blank");
  };

  return (
    <div className="refer-page">
      <div className="refer-header">
        <h1>Invite Friends & Earn AI Credits</h1>
        <p>Share Tailrd with friends and both of you earn extra AI credits for resume analysis and job matching.</p>
      </div>

      {/* Steps */}
      <div className="refer-steps">
        <div className="refer-step">
          <div className="refer-step-icon">1</div>
          <div className="refer-step-content">
            <strong>Share your link</strong>
            <p>Send your unique referral link to friends</p>
          </div>
        </div>
        <div className="refer-step">
          <div className="refer-step-icon">2</div>
          <div className="refer-step-content">
            <strong>Friend signs up</strong>
            <p>Your friend creates an account and uploads their resume</p>
          </div>
        </div>
        <div className="refer-step">
          <div className="refer-step-icon">3</div>
          <div className="refer-step-content">
            <strong>Both earn credits</strong>
            <p>You both get +5 AI analysis credits</p>
          </div>
        </div>
      </div>

      {/* Referral Link */}
      <div className="refer-link-section">
        <h3>Your Referral Link</h3>
        <div className="refer-link-row">
          <input type="text" readOnly value={referralLink} className="refer-link-input" />
          <button className="refer-copy-btn" onClick={copyLink}>
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <div className="refer-share-row">
          <span>Share on:</span>
          <button className="refer-social-btn" onClick={shareLinkedIn} aria-label="Share on LinkedIn">
            <i className="fa-brands fa-linkedin"></i>
          </button>
          <button className="refer-social-btn" onClick={shareTwitter} aria-label="Share on X">
            <i className="fa-brands fa-x-twitter"></i>
          </button>
        </div>
      </div>

      {/* Rewards */}
      <div className="refer-rewards">
        <h3>Your Rewards</h3>
        <div className="refer-rewards-grid">
          <div className="refer-reward-card">
            <span className="refer-reward-number">0</span>
            <span className="refer-reward-label">Invites Completed</span>
          </div>
          <div className="refer-reward-card">
            <span className="refer-reward-number">0</span>
            <span className="refer-reward-label">Resume Analysis Credits</span>
          </div>
          <div className="refer-reward-card">
            <span className="refer-reward-number">0</span>
            <span className="refer-reward-label">Match Score Credits</span>
          </div>
        </div>
      </div>
    </div>
  );
}
