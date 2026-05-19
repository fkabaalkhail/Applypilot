# Requirements Document

## Introduction

This feature adds email verification for manual (non-OAuth) signups using the Resend email service. After registering with email and password, users must verify their email address before gaining full access to the application. Google OAuth users bypass verification since Google already validates their email. The system sends a verification email containing a unique token link, and provides the ability to resend the verification email.

## Glossary

- **Verification_Service**: The backend module responsible for generating verification tokens, sending verification emails via Resend, and validating tokens upon user confirmation.
- **Auth_Router**: The FastAPI router handling authentication endpoints including registration, login, token refresh, and email verification.
- **Email_Gateway**: The integration layer that communicates with the Resend API to deliver transactional emails.
- **Verification_Token**: A cryptographically secure, time-limited token embedded in the verification link sent to the user's email.
- **User_Model**: The SQLAlchemy ORM model representing an authenticated user, stored in the `users` table.
- **Auth_Middleware**: The FastAPI dependency that validates JWT tokens and enforces access control on protected routes.
- **Frontend_Auth**: The React AuthProvider and associated components managing client-side authentication state and routing.

## Requirements

### Requirement 1: User Model Extension

**User Story:** As a developer, I want the User model to track email verification status, so that the system can distinguish between verified and unverified users.

#### Acceptance Criteria

1. THE User_Model SHALL include an `email_verified` boolean field defaulting to `false` for new local signups.
2. WHEN a user registers via Google OAuth, THE User_Model SHALL set `email_verified` to `true` upon creation and leave `verification_token` and `verification_token_expires_at` as null.
3. THE User_Model SHALL include a nullable `verification_token` string field with a maximum length of 255 characters to store the current pending token, defaulting to null when no verification is pending.
4. THE User_Model SHALL include a nullable `verification_token_expires_at` datetime field to store the token expiration timestamp, set to 24 hours after token generation, defaulting to null when no verification is pending.
5. WHEN email verification succeeds, THE User_Model SHALL set `email_verified` to `true` and set both `verification_token` and `verification_token_expires_at` to null.

### Requirement 2: Verification Token Generation

**User Story:** As a system operator, I want verification tokens to be secure and time-limited, so that email verification links cannot be forged or reused indefinitely.

#### Acceptance Criteria

1. WHEN a verification token is generated, THE Verification_Service SHALL produce a cryptographically random URL-safe alphanumeric string of exactly 32 characters.
2. WHEN a verification token is generated, THE Verification_Service SHALL set the token expiration to 24 hours from the time of creation.
3. WHEN a new verification token is generated for a user, THE Verification_Service SHALL delete any previously stored token for that user from the database before persisting the new token.
4. IF a verification token is presented that has exceeded its 24-hour expiration time, THEN THE Verification_Service SHALL reject the token and return an error response indicating the token has expired.
5. IF a verification token is presented that does not match any stored token in the database, THEN THE Verification_Service SHALL reject the token and return an error response indicating the token is invalid.

### Requirement 3: Send Verification Email on Registration

**User Story:** As a new user, I want to receive a verification email after signing up, so that I can confirm my email address and gain full access.

#### Acceptance Criteria

1. WHEN a user registers with email and password, THE Auth_Router SHALL generate a cryptographically random verification token of at least 32 characters, associate it with the user record on the User_Model, and store an expiration timestamp set to 24 hours from generation time.
2. WHEN a user registers with email and password, THE Email_Gateway SHALL send a verification email to the registered address asynchronously within 30 seconds of registration without blocking the registration response.
3. THE Email_Gateway SHALL include a verification link in the email body formatted as {FRONTEND_URL}/verify-email?token={verification_token} and a subject line indicating email verification is required.
4. THE Email_Gateway SHALL use the Resend API with a configured sender address and API key read from environment variables.
5. IF the Resend API returns an error, THEN THE Auth_Router SHALL still complete registration successfully, log the email delivery failure, and return the registration response to the user without exposing the delivery failure.
6. WHILE a user's email is unverified, THE Auth_Router SHALL restrict the user to authentication-only endpoints and deny access to protected application features until email verification is completed.
7. IF a verification token has exceeded its 24-hour expiration period, THEN THE Auth_Router SHALL reject the verification attempt and prompt the user to request a new verification email.

### Requirement 4: Verify Email Endpoint

**User Story:** As a user, I want to click the verification link in my email, so that my account becomes verified and I can use the full application.

#### Acceptance Criteria

1. WHEN a valid, non-expired verification token is submitted to the verify endpoint, THE Auth_Router SHALL set `email_verified` to `true` on the corresponding user.
2. WHEN a valid token is verified, THE Auth_Router SHALL clear the `verification_token` and `verification_token_expires_at` fields.
3. IF an expired verification token is submitted, THEN THE Auth_Router SHALL return a 410 Gone response with an error message indicating the token has expired and the user should request a new verification email.
4. IF an invalid or non-existent verification token is submitted, THEN THE Auth_Router SHALL return a 400 Bad Request response with an error message indicating the token is invalid.
5. WHEN verification succeeds, THE Auth_Router SHALL return a 200 OK response containing the user's access token, refresh token, and `email_verified: true` field.
6. IF the request body is missing the token field or the token field is empty, THEN THE Auth_Router SHALL return a 422 Validation Error response.
7. IF a verification token is submitted for a user whose `email_verified` is already `true`, THEN THE Auth_Router SHALL return a 400 Bad Request response indicating the email is already verified.

### Requirement 5: Resend Verification Email

**User Story:** As a user who did not receive or lost the verification email, I want to request a new verification email, so that I can still verify my account.

#### Acceptance Criteria

1. WHEN an authenticated, unverified user requests a new verification email, THE Verification_Service SHALL generate a new token, store it on the User_Model, and send a new verification email to the user's registered address.
2. THE Verification_Service SHALL enforce a rate limit of one resend request per 60 seconds per user.
3. IF a resend is requested within the rate limit window, THEN THE Auth_Router SHALL return a 429 Too Many Requests response including the remaining wait time in whole seconds.
4. IF the user is already verified, THEN THE Auth_Router SHALL return a 400 Bad Request response indicating the email is already verified.
5. WHEN the verification email is successfully queued for delivery, THE Auth_Router SHALL return a success response confirming that the verification email has been sent.
6. IF the Email_Gateway fails to send the resend verification email, THEN THE Auth_Router SHALL return an error response indicating that email delivery failed and the user should try again later.

### Requirement 6: Access Restriction for Unverified Users

**User Story:** As a product owner, I want unverified users to be restricted from using core features, so that only users with confirmed email addresses can fully interact with the platform.

#### Acceptance Criteria

1. WHILE a local user's `email_verified` field is `false`, WHEN the user requests any protected endpoint not in the allowed list (`/auth/verify-email`, `/auth/resend-verification`, `/auth/me`, `/auth/refresh`, `/auth/logout`), THEN THE Auth_Middleware SHALL reject the request with HTTP 403 and a response body containing an error message indicating that email verification is required.
2. WHILE a local user's `email_verified` field is `false`, WHEN the user requests any of the allowed endpoints (`/auth/verify-email`, `/auth/resend-verification`, `/auth/me`, `/auth/refresh`, `/auth/logout`), THE Auth_Middleware SHALL permit the request and process it normally.
3. WHEN a user with `auth_provider` set to `google` requests any protected endpoint, THE Auth_Middleware SHALL grant access without checking the `email_verified` field.
4. WHEN the `/auth/me` endpoint returns a response, THE Auth_Router SHALL include the `email_verified` boolean field in the JSON response payload.
5. IF a local user's `email_verified` field transitions from `false` to `true`, THEN THE Auth_Middleware SHALL grant access to all protected endpoints on subsequent requests without requiring re-authentication.
6. WHILE a local user is unverified and receives an HTTP 403 rejection, THE Auth_Middleware SHALL preserve the user's authenticated session so that the user is not logged out.

### Requirement 7: Frontend Verification Flow

**User Story:** As a user, I want to be guided through the verification process after signup, so that I understand what to do and can easily verify my email.

#### Acceptance Criteria

1. WHEN a user registers with email and password, THE Frontend_Auth SHALL redirect the user to the verification pending page (`/verify-email`) instead of the main application.
2. THE Frontend_Auth SHALL display the user's email address and instructions to check their inbox on the verification pending page.
3. THE Frontend_Auth SHALL provide a "Resend Email" button on the verification pending page.
4. IF the "Resend Email" button is clicked and the backend returns a 429 response, THEN THE Frontend_Auth SHALL disable the button and display a countdown showing the remaining seconds (out of 60) before the next resend is allowed.
5. WHEN the "Resend Email" button is clicked and the backend returns a success response, THE Frontend_Auth SHALL display a confirmation message indicating the email was sent.
6. WHEN an unverified user attempts to navigate to a protected route, THE Frontend_Auth SHALL redirect the user to the verification pending page.
7. WHEN the verification link is clicked and the verify endpoint returns a success response, THE Frontend_Auth SHALL store the returned tokens and redirect the user to the main application.
8. IF the verification link contains an expired token (verify endpoint returns 410), THEN THE Frontend_Auth SHALL display an error message indicating the link has expired, with an option to resend the verification email.
9. IF the verification link contains an invalid token (verify endpoint returns 400) or the verify request fails due to a network error, THEN THE Frontend_Auth SHALL display an error message indicating verification failed, with an option to resend the verification email.

### Requirement 8: Registration Response Change

**User Story:** As a frontend developer, I want the registration endpoint to indicate verification status, so that the frontend can route the user appropriately.

#### Acceptance Criteria

1. WHEN a local user registers via /auth/register, THE Auth_Router SHALL return the token response (access_token, refresh_token, token_type) along with an `email_verified` field set to `false`.
2. WHEN a Google OAuth user authenticates via /auth/google, THE Auth_Router SHALL return the token response (access_token, refresh_token, token_type) along with an `email_verified` field set to `true`.
3. WHEN a local user logs in via /auth/login, THE Auth_Router SHALL include the `email_verified` field in the token response, reflecting the user's current verification status stored in the database.
4. WHEN a token is refreshed via /auth/refresh, THE Auth_Router SHALL include the `email_verified` field in the token response, reflecting the user's current verification status.
5. THE Auth_Router SHALL return the `email_verified` field as a JSON boolean value (`true` or `false`) in all token responses.

### Requirement 9: Environment Configuration

**User Story:** As a developer deploying the system, I want email verification to be configured via environment variables, so that API keys and sender details are not hardcoded.

#### Acceptance Criteria

1. THE Email_Gateway SHALL read the Resend API key from the `RESEND_API_KEY` environment variable.
2. THE Email_Gateway SHALL read the sender email address from the `RESEND_FROM_EMAIL` environment variable.
3. THE Verification_Service SHALL read the frontend base URL from the `FRONTEND_URL` environment variable to construct verification links.
4. IF the `RESEND_API_KEY` or `RESEND_FROM_EMAIL` environment variable is not set or is empty, THEN THE Email_Gateway SHALL log a warning at application startup and skip email sending for any subsequent send requests without crashing the application.
5. IF the `FRONTEND_URL` environment variable is not set or is empty, THEN THE Verification_Service SHALL reject verification link generation requests and return an error indicating that the frontend URL is not configured.
6. WHEN the application starts, THE Email_Gateway and Verification_Service SHALL read all required environment variables (`RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `FRONTEND_URL`) once during initialization and reuse the loaded values for subsequent operations.

### Requirement 10: Database Migration

**User Story:** As a developer, I want the new fields added to the users table via a migration, so that existing users are not disrupted.

#### Acceptance Criteria

1. THE User_Model migration SHALL add the `email_verified` column as a non-nullable Boolean with a default value of `false`, the `verification_token` column as a nullable String with a maximum length of 255 characters, and the `verification_token_expires_at` column as a nullable DateTime to the existing `users` table.
2. WHEN the migration runs, THE User_Model migration SHALL set `email_verified` to `true` for all existing user rows to avoid locking out current accounts.
3. WHEN the migration runs, THE User_Model migration SHALL set `verification_token` and `verification_token_expires_at` to `NULL` for all existing user rows.
4. IF the migration encounters an error during execution, THEN THE User_Model migration SHALL roll back all changes so that the `users` table remains in its pre-migration state.
5. IF the `email_verified`, `verification_token`, or `verification_token_expires_at` columns already exist on the `users` table, THEN THE User_Model migration SHALL skip adding those columns and complete without error.
