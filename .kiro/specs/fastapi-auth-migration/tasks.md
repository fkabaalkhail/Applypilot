# Tasks: FastAPI Auth Migration

## Task 1: Create Backend Auth Module

### 1.1 Create password hashing module
- [x] 1.1 Create `backend/auth/passwords.py` with `hash_password()` and `verify_password()` using bcrypt (12 rounds)
- [x] 1.2 Add `bcrypt` to `backend/requirements.txt`

### 1.2 Create token management module
- [x] 1.3 Create `backend/auth/tokens.py` with `create_access_token()`, `create_refresh_token()`, and `decode_token()`
- [x] 1.4 Tokens use HS256, read `JWT_SECRET` from env, access=30min, refresh=7days

### 1.3 Create auth dependencies
- [x] 1.5 Create `backend/auth/dependencies.py` with `get_current_user`, `get_current_user_id`, `get_optional_user_id`
- [x] 1.6 `get_current_user_id` returns `int` (not `str`), `get_optional_user_id` returns `Optional[int]`

### 1.4 Write property tests for auth module
- [x] 1.7 Write property test: token encode/decode round-trip (PBT)
- [x] 1.8 Write property test: password hash/verify round-trip (PBT)
- [x] 1.9 Write property test: password hash uniqueness (same password → different hashes) (PBT)
- [x] 1.10 Write property test: wrong password rejection (PBT)
- [x] 1.11 Write property test: token type discrimination (access vs refresh) (PBT)
- [x] 1.12 Write property test: invalid token rejection (PBT)

## Task 2: Update Database Models

### 2.1 Update User model
- [x] 2.1 Add `hashed_password = Column(String, nullable=False)` to User model
- [x] 2.2 Add `email` unique constraint to User model
- [x] 2.3 Remove `clerk_user_id` column from User model

### 2.2 Update referencing table models
- [x] 2.4 Change `user_id` column in ScrapedJob from `Column(String)` to `Column(Integer, ForeignKey("users.id"))`
- [x] 2.5 Change `user_id` column in PendingQuestion from `Column(String)` to `Column(Integer, ForeignKey("users.id"))`
- [x] 2.6 Change `user_id` column in ResumeProfileDB from `Column(String)` to `Column(Integer, ForeignKey("users.id"))`
- [x] 2.7 Change `user_id` column in ApplicationRecord from `Column(String)` to `Column(Integer, ForeignKey("users.id"))`
- [x] 2.8 Change `user_id` column in UserSettings from `Column(String)` to `Column(Integer, ForeignKey("users.id"))`
- [x] 2.9 Change `user_id` column in BotRun from `Column(String)` to `Column(Integer, ForeignKey("users.id"))`
- [x] 2.10 Change `user_id` column in ConnectionRequest from `Column(String)` to `Column(Integer, ForeignKey("users.id"))`
- [x] 2.11 Change `user_id` column in AutopilotRun from `Column(String)` to `Column(Integer, ForeignKey("users.id"))`
- [x] 2.12 Change `user_id` column in TailoredResume from `Column(String)` to `Column(Integer, ForeignKey("users.id"))`
- [x] 2.13 Change `user_id` column in InsiderConnection from `Column(String)` to `Column(Integer, ForeignKey("users.id"))`

## Task 3: Rewrite Auth Router

### 3.1 Replace Clerk router with custom auth
- [x] 3.1 Rewrite `backend/routers/auth.py` with POST /register, POST /login, POST /refresh, GET /me, PUT /me endpoints
- [x] 3.2 Remove Clerk webhook endpoint entirely
- [x] 3.3 Add Pydantic schemas: RegisterRequest, LoginRequest, TokenResponse, RefreshRequest

## Task 4: Update All Routers

### 4.1 Update imports and type annotations
- [x] 4.1 Update `backend/routers/ai.py`: change import to `backend.auth.dependencies`, change `user_id: str` to `user_id: int`
- [x] 4.2 Update `backend/routers/apply.py`: change import to `backend.auth.dependencies`, change `user_id: str` to `user_id: int`
- [x] 4.3 Update `backend/routers/connections.py`: change import to `backend.auth.dependencies`, change `user_id: str` to `user_id: int`
- [x] 4.4 Update `backend/routers/fill.py`: change import to `backend.auth.dependencies`, change `user_id: str` to `user_id: int`
- [x] 4.5 Update `backend/routers/jobs.py`: change import to `backend.auth.dependencies`, change `user_id: str` to `user_id: int`
- [x] 4.6 Update `backend/routers/resumes.py`: change import to `backend.auth.dependencies`, change `user_id: str` to `user_id: int`
- [x] 4.7 Update `backend/routers/settings.py`: change import to `backend.auth.dependencies`, change `user_id: str` to `user_id: int`

### 4.2 Update auth __init__.py
- [x] 4.8 Update `backend/auth/__init__.py` to re-export from `backend.auth.dependencies` instead of `backend.auth.clerk`

## Task 5: Remove Clerk Backend

- [x] 5.1 Delete `backend/auth/clerk.py`
- [x] 5.2 Remove `CLERK_ISSUER` and `CLERK_WEBHOOK_SECRET` from `.env` and any env documentation

## Task 6: Update Backend Tests

- [x] 6.1 Update `backend/tests/conftest.py`: change TEST_USER_ID to integer, update dependency overrides to use `backend.auth.dependencies`
- [x] 6.2 Update `backend/tests/test_ai_router.py`: change import and override to use `backend.auth.dependencies`
- [x] 6.3 Update `backend/tests/test_apply_integration.py`: change import and override to use `backend.auth.dependencies`

## Task 7: Create Frontend Auth Module

### 7.1 Create auth infrastructure
- [x] 7.1 Create `frontend/src/auth/api.ts` with axios instance, request interceptor (attach token), response interceptor (refresh on 401)
- [x] 7.2 Create `frontend/src/auth/AuthContext.tsx` with AuthState interface and React context
- [x] 7.3 Create `frontend/src/auth/AuthProvider.tsx` with login, register, logout, getToken methods and localStorage management
- [x] 7.4 Create `frontend/src/auth/ProtectedRoute.tsx` that redirects to /sign-in if not authenticated
- [x] 7.5 Create `frontend/src/auth/useAuth.ts` hook exposing isAuthenticated, user, login, register, logout, getToken

### 7.2 Rewrite auth pages
- [x] 7.6 Rewrite `frontend/src/pages/SignIn.tsx` with custom email/password login form
- [x] 7.7 Rewrite `frontend/src/pages/SignUp.tsx` with custom email/password/confirm-password registration form

## Task 8: Update Frontend App Shell

- [x] 8.1 Update `frontend/src/main.tsx`: replace ClerkProvider with AuthProvider, replace ProtectedRoute logic
- [x] 8.2 Update `frontend/src/App.tsx`: replace UserButton and useUser with useAuth hook
- [x] 8.3 Update `frontend/src/pages/Landing.tsx`: replace useUser/isSignedIn with useAuth/isAuthenticated
- [x] 8.4 Update or delete `frontend/src/hooks/useAuthFetch.ts`: replace with re-export of api from auth module

## Task 9: Update Frontend Pages Using Auth

- [x] 9.1 Update `frontend/src/pages/Jobs.tsx`: replace useAuthFetch with api from auth module
- [x] 9.2 Update `frontend/src/pages/Resume.tsx`: replace useAuthFetch with api from auth module
- [x] 9.3 Update `frontend/src/pages/ResumeDetail.tsx`: replace useAuthFetch with api from auth module
- [x] 9.4 Update `frontend/src/pages/Settings.tsx`: replace useAuthFetch with api from auth module

## Task 10: Remove Clerk Frontend

- [x] 10.1 Remove `@clerk/clerk-react` from `frontend/package.json` and run install
- [x] 10.2 Remove `VITE_CLERK_PUBLISHABLE_KEY` from frontend env files
- [x] 10.3 Verify no remaining Clerk imports in the frontend codebase

## Task 11: Database Migration SQL

- [x] 11.1 Create `backend/db/migrate_remove_clerk.py` script containing the full migration SQL for reference
- [x] 11.2 Document the SQL to run in Neon SQL editor (provided in design doc)

## Task 12: Environment Variable Updates

- [x] 12.1 Add `JWT_SECRET` to `.env` (generate with `openssl rand -hex 32`)
- [x] 12.2 Add `JWT_SECRET` to Vercel environment variables
- [x] 12.3 Remove `CLERK_ISSUER`, `CLERK_WEBHOOK_SECRET`, `VITE_CLERK_PUBLISHABLE_KEY` from Vercel environment variables
