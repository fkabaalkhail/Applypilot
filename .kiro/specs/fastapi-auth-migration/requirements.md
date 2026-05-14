# Requirements Document

## Introduction

Migration from Clerk-hosted authentication to a self-hosted FastAPI-based authentication system. The system currently uses Clerk for JWT verification (via JWKS), webhook-based user sync, and frontend UI components (@clerk/clerk-react). This migration replaces all Clerk dependencies with a custom email/password auth system using FastAPI, bcrypt password hashing, and self-issued JWT tokens. The database schema migrates from string-based `clerk_user_id` foreign keys to integer-based user IDs.

## Glossary

- **Auth_Service**: The custom FastAPI authentication backend module that handles registration, login, token issuance, and token verification
- **Token_Manager**: The component responsible for issuing, refreshing, and validating JWT access and refresh tokens
- **Password_Hasher**: The component that hashes and verifies user passwords using bcrypt
- **Auth_Client**: The frontend React module that manages authentication state, token storage, and protected route access
- **User_Table**: The `users` PostgreSQL table storing user credentials and profile data
- **Referencing_Tables**: The set of 10 tables (scraped_jobs, pending_questions, resume_profiles, application_records, user_settings, bot_runs, connection_requests, autopilot_runs, tailored_resumes, insider_connections) that reference user ownership via a `user_id` column
- **Migration_Script**: SQL statements executed against Neon PostgreSQL to transform the schema from Clerk-based string IDs to integer-based user IDs

## Requirements

### Requirement 1: User Registration

**User Story:** As a new user, I want to register with my email and password, so that I can create an account without relying on a third-party auth provider.

#### Acceptance Criteria

1. WHEN a registration request is received with a valid email and password, THE Auth_Service SHALL create a new user record in the User_Table with the email and a bcrypt-hashed password
2. WHEN a registration request is received with an email that already exists in the User_Table, THE Auth_Service SHALL return a 409 Conflict response with a descriptive error message
3. WHEN a registration request is received with a password shorter than 8 characters, THE Auth_Service SHALL return a 422 Validation Error response
4. WHEN a registration request is received with an invalid email format, THE Auth_Service SHALL return a 422 Validation Error response
5. WHEN registration succeeds, THE Auth_Service SHALL return an access token and a refresh token in the response body

### Requirement 2: User Login

**User Story:** As a registered user, I want to log in with my email and password, so that I can access my account and data.

#### Acceptance Criteria

1. WHEN a login request is received with a valid email and correct password, THE Auth_Service SHALL return an access token and a refresh token
2. WHEN a login request is received with an email that does not exist in the User_Table, THE Auth_Service SHALL return a 401 Unauthorized response
3. WHEN a login request is received with an incorrect password, THE Auth_Service SHALL return a 401 Unauthorized response
4. THE Auth_Service SHALL use the same error message for non-existent email and incorrect password to prevent user enumeration

### Requirement 3: JWT Token Issuance and Verification

**User Story:** As an authenticated user, I want my session to be maintained via JWT tokens, so that I can make authenticated API requests without re-entering credentials.

#### Acceptance Criteria

1. THE Token_Manager SHALL issue access tokens with a configurable expiration time (default: 30 minutes)
2. THE Token_Manager SHALL issue refresh tokens with a configurable expiration time (default: 7 days)
3. THE Token_Manager SHALL sign tokens using HS256 with a secret key loaded from the `JWT_SECRET` environment variable
4. WHEN a request includes a valid, non-expired access token in the Authorization Bearer header, THE Auth_Service SHALL extract the user ID from the token `sub` claim and make it available to route handlers
5. WHEN a request includes an expired access token, THE Auth_Service SHALL return a 401 Unauthorized response with detail "Token expired"
6. WHEN a request includes a malformed or invalid token, THE Auth_Service SHALL return a 401 Unauthorized response with detail "Invalid token"
7. FOR ALL valid user IDs, encoding then decoding a token SHALL produce the original user ID (round-trip property)

### Requirement 4: Token Refresh

**User Story:** As an authenticated user, I want to refresh my access token without re-entering my password, so that my session persists seamlessly.

#### Acceptance Criteria

1. WHEN a valid refresh token is submitted to the refresh endpoint, THE Token_Manager SHALL return a new access token and a new refresh token
2. WHEN an expired refresh token is submitted, THE Auth_Service SHALL return a 401 Unauthorized response
3. WHEN an invalid refresh token is submitted, THE Auth_Service SHALL return a 401 Unauthorized response

### Requirement 5: Password Hashing

**User Story:** As a user, I want my password stored securely, so that it cannot be recovered if the database is compromised.

#### Acceptance Criteria

1. THE Password_Hasher SHALL hash passwords using bcrypt with a work factor of at least 12 rounds
2. THE Password_Hasher SHALL produce different hash outputs for the same input password (salt uniqueness)
3. FOR ALL passwords, hashing then verifying with the same password SHALL return true (round-trip property)
4. FOR ALL passwords, verifying a hash against a different password SHALL return false

### Requirement 6: Auth Dependency Functions

**User Story:** As a backend developer, I want drop-in replacement auth dependency functions, so that existing routers continue to work with minimal changes.

#### Acceptance Criteria

1. THE Auth_Service SHALL provide a `get_current_user` dependency that returns the full User object from the database
2. THE Auth_Service SHALL provide a `get_current_user_id` dependency that returns the integer user ID without a database query
3. THE Auth_Service SHALL provide a `get_optional_user_id` dependency that returns the integer user ID if authenticated or None if not
4. WHEN any protected dependency receives a request without an Authorization header, THE Auth_Service SHALL raise a 401 HTTPException
5. THE Auth_Service SHALL maintain the same function signatures as the existing Clerk auth dependencies (accepting `credentials` and optionally `db` parameters via FastAPI Depends)

### Requirement 7: Database Schema Migration

**User Story:** As a developer, I want to migrate the database from Clerk string IDs to integer user IDs, so that the system no longer depends on Clerk's user identifier format.

#### Acceptance Criteria

1. THE Migration_Script SHALL add a `hashed_password` column (String, non-nullable) to the User_Table
2. THE Migration_Script SHALL convert all `user_id` columns in Referencing_Tables from String type to Integer type
3. THE Migration_Script SHALL populate the new integer `user_id` columns in Referencing_Tables using the `users.id` value that corresponds to each row's current `clerk_user_id` value
4. THE Migration_Script SHALL add foreign key constraints from each Referencing_Table's `user_id` column to `users.id`
5. THE Migration_Script SHALL remove the `clerk_user_id` column from the User_Table after data migration is complete
6. THE Migration_Script SHALL be idempotent — running it multiple times SHALL produce the same final schema state

### Requirement 8: Frontend Authentication Pages

**User Story:** As a user, I want login and registration pages in the app, so that I can authenticate without being redirected to a third-party service.

#### Acceptance Criteria

1. THE Auth_Client SHALL provide a login page at `/sign-in` with email and password fields
2. THE Auth_Client SHALL provide a registration page at `/sign-up` with email, password, and confirm password fields
3. WHEN the confirm password field does not match the password field, THE Auth_Client SHALL display a validation error before submitting
4. WHEN login or registration succeeds, THE Auth_Client SHALL store the access token and refresh token in localStorage
5. WHEN login or registration succeeds, THE Auth_Client SHALL redirect the user to `/app`
6. WHEN login or registration fails, THE Auth_Client SHALL display the error message from the API response

### Requirement 9: Frontend Token Management

**User Story:** As a user, I want my authentication tokens managed automatically, so that I stay logged in and my API requests are authenticated transparently.

#### Acceptance Criteria

1. THE Auth_Client SHALL attach the access token as a Bearer token in the Authorization header of every API request
2. WHEN an API request returns a 401 response, THE Auth_Client SHALL attempt to refresh the access token using the stored refresh token
3. WHEN token refresh succeeds, THE Auth_Client SHALL retry the original failed request with the new access token
4. WHEN token refresh fails, THE Auth_Client SHALL clear stored tokens and redirect the user to `/sign-in`
5. THE Auth_Client SHALL provide an `useAuth` hook that exposes `isAuthenticated`, `user`, `login`, `register`, `logout`, and `getToken` functions

### Requirement 10: Frontend Protected Routes

**User Story:** As a developer, I want routes under `/app` to require authentication, so that unauthenticated users cannot access protected content.

#### Acceptance Criteria

1. WHEN an unauthenticated user navigates to any route under `/app`, THE Auth_Client SHALL redirect them to `/sign-in`
2. WHEN an authenticated user navigates to `/sign-in` or `/sign-up`, THE Auth_Client SHALL redirect them to `/app`
3. THE Auth_Client SHALL remove all Clerk dependencies (@clerk/clerk-react) from the frontend codebase

### Requirement 11: Clerk Removal

**User Story:** As a developer, I want all Clerk-related code and configuration removed, so that the codebase has no residual third-party auth dependencies.

#### Acceptance Criteria

1. THE Auth_Service SHALL remove the `backend/auth/clerk.py` module
2. THE Auth_Service SHALL remove the Clerk webhook endpoint from `backend/routers/auth.py`
3. THE Auth_Client SHALL remove the `@clerk/clerk-react` package from `package.json`
4. THE Auth_Client SHALL remove all imports of ClerkProvider, SignedIn, SignedOut, RedirectToSignIn, UserButton, useUser, and useAuth from @clerk/clerk-react
5. THE Auth_Service SHALL remove the following environment variables from configuration: `CLERK_ISSUER`, `CLERK_WEBHOOK_SECRET`, `VITE_CLERK_PUBLISHABLE_KEY`

### Requirement 12: User Profile Endpoint

**User Story:** As an authenticated user, I want to retrieve my profile information, so that the frontend can display my name and email.

#### Acceptance Criteria

1. WHEN an authenticated request is made to GET `/auth/me`, THE Auth_Service SHALL return the user's id, email, first_name, last_name, and created_at
2. THE Auth_Service SHALL accept an optional PUT `/auth/me` request to update first_name, last_name, and profile_image_url
