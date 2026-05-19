"""Email delivery service using Resend API."""

import logging
import os
from typing import Optional

import resend

logger = logging.getLogger(__name__)


class EmailService:
    """Sends transactional emails via Resend."""

    def __init__(self):
        self.api_key: Optional[str] = os.getenv("RESEND_API_KEY")
        self.from_email: Optional[str] = os.getenv("RESEND_FROM_EMAIL")
        self.frontend_url: Optional[str] = os.getenv("FRONTEND_URL")

        if not self.api_key or not self.from_email:
            logger.warning(
                "RESEND_API_KEY or RESEND_FROM_EMAIL not set. "
                "Email sending will be skipped."
            )

    @property
    def is_configured(self) -> bool:
        """Check if email service has required configuration."""
        return bool(self.api_key and self.from_email)

    def _build_verification_link(self, token: str) -> str:
        """Construct the verification URL: {FRONTEND_URL}/verify-email?token={token}."""
        if not self.frontend_url:
            raise ValueError(
                "FRONTEND_URL environment variable is not set. "
                "Cannot build verification link."
            )
        return f"{self.frontend_url}/verify-email?token={token}"

    def send_verification_email(self, to_email: str, token: str) -> bool:
        """
        Send a verification email with the token link.

        Args:
            to_email: Recipient email address.
            token: The verification token to embed in the link.

        Returns:
            True if email was sent successfully, False otherwise.
        """
        if not self.is_configured:
            logger.warning(
                "Email service not configured. Skipping verification email to %s.",
                to_email,
            )
            return False

        try:
            verification_link = self._build_verification_link(token)
        except ValueError as e:
            logger.error("Failed to build verification link: %s", e)
            return False

        html_content = self._build_email_html(verification_link)

        try:
            resend.api_key = self.api_key
            resend.Emails.send(
                {
                    "from": self.from_email,
                    "to": [to_email],
                    "subject": "Verify your email address",
                    "html": html_content,
                }
            )
            logger.info("Verification email sent to %s.", to_email)
            return True
        except Exception as e:
            logger.error("Failed to send verification email to %s: %s", to_email, e)
            return False

    def _build_email_html(self, verification_link: str) -> str:
        """Build the HTML content for the verification email."""
        return f"""\
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f4f4f5;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding: 40px 20px;">
        <tr>
            <td align="center">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; background-color: #ffffff; border-radius: 8px; padding: 40px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                    <tr>
                        <td>
                            <h1 style="margin: 0 0 24px; font-size: 24px; font-weight: 600; color: #18181b;">
                                Verify your email
                            </h1>
                            <p style="margin: 0 0 24px; font-size: 16px; line-height: 1.5; color: #3f3f46;">
                                Thanks for signing up. Please click the button below to verify your email address and activate your account.
                            </p>
                            <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px;">
                                <tr>
                                    <td style="border-radius: 6px; background-color: #2563eb;">
                                        <a href="{verification_link}" target="_blank" style="display: inline-block; padding: 12px 24px; font-size: 16px; font-weight: 500; color: #ffffff; text-decoration: none;">
                                            Verify Email Address
                                        </a>
                                    </td>
                                </tr>
                            </table>
                            <p style="margin: 0 0 16px; font-size: 14px; line-height: 1.5; color: #71717a;">
                                Or copy and paste this link into your browser:
                            </p>
                            <p style="margin: 0 0 24px; font-size: 14px; line-height: 1.5; color: #2563eb; word-break: break-all;">
                                {verification_link}
                            </p>
                            <p style="margin: 0; font-size: 14px; line-height: 1.5; color: #a1a1aa;">
                                This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>"""


# Module-level singleton, initialized once at import time
email_service = EmailService()
