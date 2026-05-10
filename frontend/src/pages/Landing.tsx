import { useNavigate } from "react-router-dom";
import "./Landing.css";

export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="landing">
      {/* Nav */}
      <nav className="landing-nav">
        <div className="landing-nav-inner">
          <div className="landing-brand">
            <img src="/logo-icon.png" alt="Resumate" className="landing-logo-img" />
            <span className="landing-logo-text">Resumate</span>
          </div>
          <div className="landing-nav-links">
            <a href="#features">Features</a>
            <a href="#how-it-works">How It Works</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div className="landing-nav-actions">
            <button className="btn-ghost" onClick={() => navigate("/app")}>Log In</button>
            <button className="btn-cta" onClick={() => navigate("/app")}>Get Started Free</button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero">
        <div className="hero-badge">🚀 AI-Powered Job Applications</div>
        <h1>Land Your Dream Job<br /><span className="hero-accent">10x Faster</span></h1>
        <p className="hero-sub">
          Resumate auto-fills job applications with AI, tailors your resume for every role,
          and tracks everything — so you can focus on interviewing, not form-filling.
        </p>
        <div className="hero-actions">
          <button className="btn-cta btn-lg" onClick={() => navigate("/app")}>Start Applying Free</button>
          <button className="btn-outline-lg">Watch Demo</button>
        </div>
        <div className="hero-stats">
          <div className="hero-stat"><strong>50K+</strong><span>Applications Filled</span></div>
          <div className="hero-stat"><strong>3,200+</strong><span>Users</span></div>
          <div className="hero-stat"><strong>85%</strong><span>Time Saved</span></div>
        </div>
      </section>

      {/* How It Works */}
      <section className="section" id="how-it-works">
        <h2 className="section-title">How It Works</h2>
        <p className="section-sub">Three steps to automate your job search</p>
        <div className="steps-grid">
          <div className="step-card">
            <div className="step-number">1</div>
            <h3>Upload Your Resume</h3>
            <p>Our AI parses your experience, skills, and education into a smart profile.</p>
          </div>
          <div className="step-card">
            <div className="step-number">2</div>
            <h3>Install the Extension</h3>
            <p>One click fills entire application forms on LinkedIn, Greenhouse, Lever, and more.</p>
          </div>
          <div className="step-card">
            <div className="step-number">3</div>
            <h3>Apply & Track</h3>
            <p>AI answers screening questions, tailors your resume, and tracks every application.</p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="section section-dark" id="features">
        <h2 className="section-title">Everything You Need</h2>
        <p className="section-sub">Built for serious job seekers who want results</p>
        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">🤖</div>
            <h3>AI Form Filler</h3>
            <p>Answers screening questions intelligently using your resume and job context.</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📄</div>
            <h3>Resume Tailoring</h3>
            <p>Automatically highlights relevant skills for each specific job posting.</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🎯</div>
            <h3>Job Match Scoring</h3>
            <p>See how well you match before applying. Focus on roles where you'll stand out.</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">⚡</div>
            <h3>One-Click Apply</h3>
            <p>Fill entire multi-page applications in seconds. Works on all major ATS platforms.</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">📊</div>
            <h3>Application Tracker</h3>
            <p>Dashboard shows every application, status, and response rate in one place.</p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🔒</div>
            <h3>Privacy First</h3>
            <p>Your data stays yours. No selling to recruiters. Local AI processing available.</p>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="section" id="pricing">
        <h2 className="section-title">Simple Pricing</h2>
        <p className="section-sub">Start free, upgrade when you're ready</p>
        <div className="pricing-grid">
          <div className="pricing-card">
            <h3>Free</h3>
            <div className="pricing-price">$0<span>/month</span></div>
            <ul className="pricing-features">
              <li>✓ 10 AI fills per month</li>
              <li>✓ 1 resume profile</li>
              <li>✓ Basic job matching</li>
              <li>✓ Application tracker</li>
            </ul>
            <button className="btn-outline-lg w-full" onClick={() => navigate("/app")}>Get Started</button>
          </div>
          <div className="pricing-card pricing-featured">
            <div className="pricing-badge">Most Popular</div>
            <h3>Pro</h3>
            <div className="pricing-price">$19<span>/month</span></div>
            <ul className="pricing-features">
              <li>✓ Unlimited AI fills</li>
              <li>✓ Unlimited resumes</li>
              <li>✓ Resume tailoring per job</li>
              <li>✓ Cover letter generation</li>
              <li>✓ Priority AI processing</li>
              <li>✓ Advanced match scoring</li>
            </ul>
            <button className="btn-cta btn-lg w-full" onClick={() => navigate("/app")}>Start Pro Trial</button>
          </div>
          <div className="pricing-card">
            <h3>Team</h3>
            <div className="pricing-price">$49<span>/month</span></div>
            <ul className="pricing-features">
              <li>✓ Everything in Pro</li>
              <li>✓ 5 team members</li>
              <li>✓ Shared job board</li>
              <li>✓ Analytics dashboard</li>
              <li>✓ Priority support</li>
            </ul>
            <button className="btn-outline-lg w-full">Contact Us</button>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="section cta-section">
        <h2>Ready to Land Your Next Role?</h2>
        <p>Join thousands of job seekers who apply smarter, not harder.</p>
        <button className="btn-cta btn-lg" onClick={() => navigate("/app")}>Get Started Free →</button>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <img src="/logo-icon.png" alt="Resumate" className="landing-logo-img" />
            <span className="landing-logo-text">Resumate</span>
          </div>
          <div className="footer-links">
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
          </div>
          <p className="footer-copy">© 2026 Resumate. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
