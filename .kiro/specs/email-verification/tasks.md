# Implementation Plan: Email Verification

## Overview

This plan implements email verification for local (email+password) signups. The implementation follows a bottom-up approach: extending the data model first, then building the verification and email services, updating auth endpoints, adding middleware-level access control, and finally updating the frontend to handle the verification flow.

## Tasks

- [x] 1. Extend User model and run migration
  - [x] 1.1 Add email verification fields to the User model
    - Add `email_verified` (Boolean, default=False, non-nullable), `verification_token` (String(255), nullable), and `verification_token_expires_at` (DateTime, nullable) columns to the `User` class in `backend/db/models.py`
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 1.2 Create the database migration script
    - Create `backend/migrations/add_email_verification.py` with idempotent migration logic
    - Add columns if they don't exist, set `email_verified=true` for all existing rows
    - Handle rollback on error
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 1.3 Run migration on application startup
    - Wire the migration to run during app initialization (e.g., in `backend/main.py` or a startup event)
    - _Requirements: 10.1_

- [x] 2. Implement verification service
  - [x] 2.1 Create `backend/services/verification_service.py`
    - Implement `generate_token()` — cryptographically random URL-safe string of exactly 32 characters
    - Implement `create_verification_token(user, db)` — generates token, replaces any existing token, stores with 24h expiration
    - Implement `verify_token(token, db)` — looks up token, checks expiration, returns (user, error) tuple
    - Implement `can_resend(user)` — checks if 60 seconds have passed since last token generation
    - Implement `mark_verified(user, db)` — sets `email_verified=true`, clears token fields
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 5.2_

  - [ ]* 2.2 Write property tests for token generation (Property 2)
    - **Property 2: Token format invariant**
    - Test that `generate_token()` always produces exactly 32 URL-safe alphanumeric characters
    - **Validates: Requirements 2.1, 3.1**

  - [ ]* 2.3 Write property tests for token expiration (Property 3)
    - **Property 3: Token expiration is 24 hours from creation**
    - Test that `create_verification_token()` sets expiration within 1 second of now + 24h
    - **Validates: Requirements 1.4, 2.2, 3.1**

  - [ ]* 2.4 Write property tests for token replacement (Property 4)
    - **Property 4: Token replacement (idempotence)**
    - Test that calling `create_verification_token()` N times results in exactly one stored token (the latest)
    - **Validates: Requirements 2.3, 5.1**

  - [ ]* 2.5 Write property tests for token validation (Property 5)
    - **Property 5: Token validation correctness**
    - Test valid/expired/missing token scenarios return correct results
    - **Validates: Requirements 2.4, 2.5, 3.7, 4.1, 4.3, 4.4**

  - [ ]* 2.6 Write property tests for verification state transition (Property 6)
    - **Property 6: Verification state transition**
    - Test that `mark_verified()` sets `email_verified=true` and clears token fields
    - **Validates: Requirements 1.5, 4.1, 4.2**

  - [ ]* 2.7 Write property tests for rate limiting (Property 11)
    - **Property 11: Rate limiting on resend**
    - Test that `can_resend()` returns False within 60s of token creation and True after
    - **Validates: Requirements 5.2, 5.3**

- [x] 3. Implement email service
  - [x] 3.1 Create `backend/services/email_service.py`
    - Implement `EmailService` class with Resend API integration
    - Read `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `FRONTEND_URL` from environment variables
    - Implement `send_verification_email(to_email, token)` — sends email via Resend with verification link
    - Implement `_build_verification_link(token)` — constructs `{FRONTEND_URL}/verify-email?token={token}`
    - Implement `is_configured` property for graceful degradation
    - Create module-level singleton `email_service`
    - _Requirements: 3.2, 3.3, 3.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x] 3.2 Add `resend` package to `backend/requirements.txt`
    - Add pinned version of the `resend` Python package
    - _Requirements: 3.4_

  - [ ]* 3.3 Write property test for verification link format (Property 7)
    - **Property 7: Verification email link format**
    - Test that `_build_verification_link(token)` produces `{FRONTEND_URL}/verify-email?token={token}` for any valid token and FRONTEND_URL
    - **Validates: Requirements 3.3**

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Update auth router endpoints
  - [x] 5.1 Create new response schema `TokenResponseWithVerification`
    - Add `email_verified: bool` field to token response
    - Create `VerifyEmailRequest` and `ResendVerificationResponse` schemas
    - _Requirements: 8.5_

  - [x] 5.2 Modify `POST /auth/register` to trigger verification
    - Generate verification token after user creation
    - Send verification email asynchronously (fire-and-forget, catch errors)
    - Return `TokenResponseWithVerification` with `email_verified=false`
    - Set `email_verified=true` for Google OAuth users on creation
    - _Requirements: 3.1, 3.2, 3.5, 8.1, 1.2_

  - [x] 5.3 Modify `POST /auth/login` to include `email_verified`
    - Return `TokenResponseWithVerification` with current `email_verified` status from DB
    - _Requirements: 8.3_

  - [x] 5.4 Modify `POST /auth/google` to include `email_verified`
    - Return `TokenResponseWithVerification` with `email_verified=true`
    - Set `email_verified=true` on new Google user creation
    - _Requirements: 8.2, 1.2_

  - [x] 5.5 Modify `POST /auth/refresh` to include `email_verified`
    - Query user from DB to get current `email_verified` status
    - Return `TokenResponseWithVerification`
    - _Requirements: 8.4_

  - [x] 5.6 Modify `GET /auth/me` to include `email_verified`
    - Add `email_verified` field to the response payload
    - _Requirements: 6.4_

  - [x] 5.7 Implement `POST /auth/verify-email` endpoint
    - Accept `VerifyEmailRequest` body with token
    - Call `verify_token()` — return 400 for invalid, 410 for expired, 400 for already verified
    - On success: call `mark_verified()`, return fresh tokens with `email_verified=true`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 5.8 Implement `POST /auth/resend-verification` endpoint
    - Require authenticated user via `get_current_user` dependency
    - Check if already verified (return 400)
    - Check rate limit via `can_resend()` (return 429 with `retry_after`)
    - Generate new token and send email
    - Return 500 if email send fails, success message otherwise
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [ ]* 5.9 Write property test for registration fault tolerance (Property 8)
    - **Property 8: Registration fault tolerance**
    - Test that registration succeeds even when email service raises an exception
    - **Validates: Requirements 3.5**

  - [ ]* 5.10 Write property test for user creation defaults (Property 1)
    - **Property 1: User creation defaults by auth provider**
    - Test that local users get `email_verified=false` and Google users get `email_verified=true` with null token fields
    - **Validates: Requirements 1.1, 1.2, 8.1, 8.2**

  - [ ]* 5.11 Write property test for token response format (Property 12)
    - **Property 12: All token responses include email_verified**
    - Test that all token endpoints include `email_verified` boolean matching DB state
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5**

- [x] 6. Implement auth middleware for verification enforcement
  - [x] 6.1 Add `get_verified_user` dependency to `backend/auth/dependencies.py`
    - Define `VERIFICATION_EXEMPT_PATHS` set
    - Implement `get_verified_user()` — checks `email_verified` for local users, bypasses for Google users
    - Return HTTP 403 with `"Email verification required"` for unverified local users on non-exempt paths
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6_

  - [x] 6.2 Apply `get_verified_user` dependency to protected routes
    - Replace `get_current_user` with `get_verified_user` on routes that require verification
    - Keep `get_current_user` on exempt endpoints (verify-email, resend-verification, me, refresh)
    - _Requirements: 6.1, 6.2_

  - [ ]* 6.3 Write property test for access control (Property 9)
    - **Property 9: Access control for unverified local users**
    - Test that unverified local users get 403 on non-exempt paths and pass on exempt paths
    - **Validates: Requirements 3.6, 6.1, 6.2**

  - [ ]* 6.4 Write property test for Google OAuth bypass (Property 10)
    - **Property 10: Google OAuth verification bypass**
    - Test that Google users are never blocked by verification middleware regardless of path
    - **Validates: Requirements 6.3**

  - [ ]* 6.5 Write property test for session preservation (Property 13)
    - **Property 13: Session preservation on 403**
    - Test that after receiving 403, subsequent requests to exempt endpoints still succeed with the same JWT
    - **Validates: Requirements 6.5, 6.6**

- [x] 7. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Update frontend auth context and types
  - [x] 8.1 Update `AuthContext.tsx` types
    - Add `email_verified: boolean` to `UserProfile` interface
    - Add `resendVerification: () => Promise<void>` and `isEmailVerified: boolean` to `AuthContextValue`
    - _Requirements: 7.1, 7.3_

  - [x] 8.2 Update `AuthProvider.tsx` logic
    - Update `register()` to check `email_verified` in response
    - Add `resendVerification()` method that calls `POST /auth/resend-verification`
    - Add `isEmailVerified` computed property (`user?.email_verified ?? false`)
    - Handle 403 responses in axios interceptor to redirect to `/verify-email`
    - _Requirements: 7.1, 7.3, 7.6_

- [x] 9. Create frontend verification page
  - [x] 9.1 Create `frontend/src/pages/VerifyEmail.tsx`
    - Implement pending mode: show user's email, "check your inbox" instructions, and "Resend Email" button
    - Implement verifying mode: when `?token=` is in URL, call `POST /auth/verify-email`
    - Handle success: store tokens, redirect to main app
    - Handle 410 (expired): show "link expired" message with resend button
    - Handle 400 (invalid): show "invalid link" message with resend button
    - Handle 429 (rate limited): disable resend button, show countdown timer
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 7.7, 7.8, 7.9_

- [x] 10. Update frontend route protection
  - [x] 10.1 Update `ProtectedRoute.tsx` to check email verification
    - Add `isEmailVerified` check after authentication check
    - Redirect unverified users to `/verify-email`
    - _Requirements: 7.6_

  - [x] 10.2 Add `/verify-email` route to the app router
    - Register the `VerifyEmail` page component at `/verify-email`
    - Ensure it's accessible to authenticated but unverified users
    - _Requirements: 7.1, 7.7_

  - [ ]* 10.3 Write frontend tests for verification page
    - Test VerifyEmail page renders email and instructions
    - Test resend button triggers API call
    - Test 429 response disables button and shows countdown
    - Test successful verification stores tokens and redirects
    - Test expired/invalid token shows error with resend option
    - _Requirements: 7.2, 7.4, 7.5, 7.7, 7.8, 7.9_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The `resend` Python package must be added to `backend/requirements.txt`
- The migration sets `email_verified=true` for existing users to avoid locking them out
- Rate limiting uses token timestamp math (no Redis/external store needed)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "3.1", "3.2"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "3.3"] },
    { "id": 4, "tasks": ["5.1"] },
    { "id": 5, "tasks": ["5.2", "5.3", "5.4", "5.5", "5.6", "5.7", "5.8"] },
    { "id": 6, "tasks": ["5.9", "5.10", "5.11", "6.1"] },
    { "id": 7, "tasks": ["6.2", "6.3", "6.4", "6.5"] },
    { "id": 8, "tasks": ["8.1"] },
    { "id": 9, "tasks": ["8.2"] },
    { "id": 10, "tasks": ["9.1"] },
    { "id": 11, "tasks": ["10.1", "10.2"] },
    { "id": 12, "tasks": ["10.3"] }
  ]
}
```
