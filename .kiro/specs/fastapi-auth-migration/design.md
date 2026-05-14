# Design Document: FastAPI Auth Migration

## Overview

This design replaces Clerk-hosted authentication with a self-hosted FastAPI auth system. The backend gains email/password registration, login, and JWT token management. The frontend replaces Clerk's React SDK with a custom auth context, token interceptor, and login/register pages. The database migrates from string-based `clerk_user_id` to integer-based `user_id` foreign keys.

## Architecture

### Backend Auth Module (`backend/auth/`)

```
backend/auth/
├── __init__.py          # Re-exports get_current_user, get_current_user_id, get_optional_user_id
├── passwords.py         # bcrypt hashing and verification
├── tokens.py            # JWT encode/decode (access + refresh tokens)
└── dependencies.py      # FastAPI Depends functions for route protection
```

### Backend Auth Router (`backend/routers/auth.py`)

Endpoints:
- `POST /auth/register` — create user, return tokens
- `POST /auth/login` — verify credentials, return tokens
- `POST /auth/refresh` — exchange refresh token for new token pair
- `GET /auth/me` — return authenticated user profile
- `PUT /auth/me` — update user profile fields

### Frontend Auth Module (`frontend/src/auth/`)

```
frontend/src/auth/
├── AuthContext.tsx       # React context providing auth state + methods
├── AuthProvider.tsx      # Provider component wrapping the app
├── ProtectedRoute.tsx   # Route guard redirecting unauthenticated users
├── useAuth.ts           # Hook exposing isAuthenticated, user, login, register, logout, getToken
└── api.ts               # Axios instance with token interceptor + refresh logic
```

### Frontend Auth Pages

```
frontend/src/pages/
├── SignIn.tsx            # Custom login form (replaces Clerk SignIn)
└── SignUp.tsx            # Custom registration form (replaces Clerk SignUp)
```

## Component Design

### 1. Password Hashing (`backend/auth/passwords.py`)

```python
import bcrypt

BCRYPT_ROUNDS = 12

def hash_password(password: str) -> str:
    """Hash a plaintext password using bcrypt."""
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=BCRYPT_ROUNDS)).decode()

def verify_password(password: str, hashed: str) -> bool:
    """Verify a plaintext password against a bcrypt hash."""
    return bcrypt.checkpw(password.encode(), hashed.encode())
```

### 2. Token Management (`backend/auth/tokens.py`)

```python
import os
from datetime import datetime, timedelta, timezone
from typing import Optional
import jwt

JWT_SECRET = os.getenv("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 30
REFRESH_TOKEN_EXPIRE_DAYS = 7

def create_access_token(user_id: int) -> str:
    """Create a short-lived access token."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": str(user_id), "exp": expire, "type": "access"}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def create_refresh_token(user_id: int) -> str:
    """Create a long-lived refresh token."""
    expire = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {"sub": str(user_id), "exp": expire, "type": "refresh"}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def decode_token(token: str) -> dict:
    """Decode and verify a JWT. Raises jwt.InvalidTokenError on failure."""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
```

### 3. Auth Dependencies (`backend/auth/dependencies.py`)

```python
from typing import Optional
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
import jwt

from backend.db.database import get_db
from backend.db.models import User
from backend.auth.tokens import decode_token

security = HTTPBearer(auto_error=False)

async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    """Requires valid JWT. Returns the full User object."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_id = int(payload["sub"])
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

async def get_current_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> int:
    """Requires valid JWT. Returns just the integer user ID (no DB query)."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    return int(payload["sub"])

async def get_optional_user_id(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Optional[int]:
    """Returns integer user ID if authenticated, None otherwise."""
    if not credentials:
        return None
    try:
        payload = decode_token(credentials.credentials)
        if payload.get("type") != "access":
            return None
        return int(payload["sub"])
    except Exception:
        return None
```

### 4. Auth Router (`backend/routers/auth.py`)

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr

from backend.db.database import get_db
from backend.db.models import User
from backend.auth.passwords import hash_password, verify_password
from backend.auth.tokens import create_access_token, create_refresh_token, decode_token
from backend.auth.dependencies import get_current_user

router = APIRouter()

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str  # min_length=8 validated in endpoint

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"

class RefreshRequest(BaseModel):
    refresh_token: str

@router.post("/register", response_model=TokenResponse)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")
    existing = db.query(User).filter(User.email == body.email).first()
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")
    user = User(email=body.email, hashed_password=hash_password(body.password))
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )

@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == body.email).first()
    if not user or not verify_password(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )

@router.post("/refresh", response_model=TokenResponse)
def refresh(body: RefreshRequest):
    try:
        payload = decode_token(body.refresh_token)
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid token type")
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    user_id = int(payload["sub"])
    return TokenResponse(
        access_token=create_access_token(user_id),
        refresh_token=create_refresh_token(user_id),
    )

@router.get("/me")
def get_me(user: User = Depends(get_current_user)):
    return {
        "id": user.id,
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "created_at": user.created_at.isoformat() if user.created_at else None,
    }
```

### 5. Database Model Changes (`backend/db/models.py`)

```python
class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, nullable=False, index=True)
    hashed_password = Column(String, nullable=False)
    first_name = Column(String, default="")
    last_name = Column(String, default="")
    profile_image_url = Column(String, default="")
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
```

All Referencing_Tables change `user_id` from `Column(String, ...)` to `Column(Integer, ForeignKey("users.id"), ...)`.

### 6. Database Migration SQL (for Neon)

This is the SQL the user runs in the Neon SQL editor. It must be run in order:

```sql
-- Step 1: Add hashed_password column to users (nullable initially for migration)
ALTER TABLE users ADD COLUMN IF NOT EXISTS hashed_password VARCHAR;

-- Step 2: For each referencing table, add a new integer column, populate it, then swap
-- We'll do this for all 10 tables. Example pattern for scraped_jobs:

-- 2a: Add new integer user_id column (temp name)
ALTER TABLE scraped_jobs ADD COLUMN IF NOT EXISTS user_id_new INTEGER;

-- 2b: Populate from users table mapping
UPDATE scraped_jobs sj
SET user_id_new = u.id
FROM users u
WHERE sj.user_id = u.clerk_user_id;

-- 2c: Drop old column, rename new
ALTER TABLE scraped_jobs DROP COLUMN IF EXISTS user_id;
ALTER TABLE scraped_jobs RENAME COLUMN user_id_new TO user_id;

-- 2d: Add foreign key and index
CREATE INDEX IF NOT EXISTS ix_scraped_jobs_user_id ON scraped_jobs(user_id);
ALTER TABLE scraped_jobs ADD CONSTRAINT fk_scraped_jobs_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- Repeat for: pending_questions, resume_profiles, application_records,
-- user_settings, bot_runs, connection_requests, autopilot_runs,
-- tailored_resumes, insider_connections

-- Step 3: Remove clerk_user_id from users
ALTER TABLE users DROP COLUMN IF EXISTS clerk_user_id;

-- Step 4: Make email unique and not-null (if not already)
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_email ON users(email);
```

### 7. Frontend Auth Context (`frontend/src/auth/AuthContext.tsx`)

```typescript
interface AuthState {
  isAuthenticated: boolean;
  user: UserProfile | null;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  getToken: () => string | null;
}
```

The provider:
- On mount, checks localStorage for tokens and validates by calling `/auth/me`
- Stores `access_token` and `refresh_token` in localStorage
- Provides an axios instance with interceptors for auto-refresh

### 8. Frontend API Client (`frontend/src/auth/api.ts`)

```typescript
import axios from "axios";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

const api = axios.create({ baseURL: API_BASE });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("access_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      const refreshToken = localStorage.getItem("refresh_token");
      if (refreshToken) {
        try {
          const { data } = await axios.post(`${API_BASE}/auth/refresh`, {
            refresh_token: refreshToken,
          });
          localStorage.setItem("access_token", data.access_token);
          localStorage.setItem("refresh_token", data.refresh_token);
          originalRequest.headers.Authorization = `Bearer ${data.access_token}`;
          return api(originalRequest);
        } catch {
          localStorage.removeItem("access_token");
          localStorage.removeItem("refresh_token");
          window.location.href = "/sign-in";
        }
      } else {
        window.location.href = "/sign-in";
      }
    }
    return Promise.reject(error);
  }
);

export default api;
```

## Correctness Properties

### Property 1: Token Round-Trip (Requirement 3.7)

For all valid integer user IDs, encoding a token and then decoding it produces the original user ID.

```
for all user_id in positive integers:
  token = create_access_token(user_id)
  payload = decode_token(token)
  assert int(payload["sub"]) == user_id
```

### Property 2: Password Hash Round-Trip (Requirement 5.3)

For all valid password strings, hashing then verifying with the same password returns true.

```
for all password in non-empty strings (length 8-128):
  hashed = hash_password(password)
  assert verify_password(password, hashed) == True
```

### Property 3: Password Hash Uniqueness (Requirement 5.2)

For all passwords, hashing the same password twice produces different hash strings (due to random salt).

```
for all password in non-empty strings:
  hash1 = hash_password(password)
  hash2 = hash_password(password)
  assert hash1 != hash2
```

### Property 4: Wrong Password Rejection (Requirement 5.4)

For all pairs of distinct passwords, verifying a hash of one against the other returns false.

```
for all (password_a, password_b) where password_a != password_b:
  hashed = hash_password(password_a)
  assert verify_password(password_b, hashed) == False
```

### Property 5: Token Type Discrimination (Requirement 3.4, 4.1)

Access tokens and refresh tokens are distinguishable — an access token cannot be used as a refresh token and vice versa.

```
for all user_id in positive integers:
  access = create_access_token(user_id)
  refresh = create_refresh_token(user_id)
  assert decode_token(access)["type"] == "access"
  assert decode_token(refresh)["type"] == "refresh"
```

### Property 6: Invalid Token Rejection (Requirement 3.6)

For all random strings that are not valid JWTs, decode_token raises an exception.

```
for all random_string not matching JWT format:
  assert decode_token(random_string) raises InvalidTokenError
```

### Property 7: Anti-Enumeration (Requirement 2.4)

Login with non-existent email and login with wrong password produce identical error responses (same status code and message).

```
for all (email, password) pairs:
  response_no_user = login(non_existent_email, password)
  response_wrong_pw = login(existing_email, wrong_password)
  assert response_no_user.status_code == response_wrong_pw.status_code
  assert response_no_user.json()["detail"] == response_wrong_pw.json()["detail"]
```

## Migration Strategy

### Order of Operations

1. **Add new auth module** — create `backend/auth/passwords.py`, `backend/auth/tokens.py`, `backend/auth/dependencies.py`
2. **Update User model** — add `hashed_password` column, keep `clerk_user_id` temporarily
3. **Create new auth router** — register, login, refresh, me endpoints
4. **Run database migration SQL** — in Neon SQL editor
5. **Update all routers** — change imports from `backend.auth.clerk` to `backend.auth.dependencies`, change `user_id: str` to `user_id: int`
6. **Update all model `user_id` columns** — String → Integer with ForeignKey
7. **Build frontend auth module** — AuthContext, api client, pages
8. **Remove Clerk** — delete clerk.py, remove @clerk/clerk-react, clean env vars
9. **Update tests** — change test user IDs from strings to integers

### Environment Variables

Remove:
- `CLERK_ISSUER`
- `CLERK_WEBHOOK_SECRET`
- `VITE_CLERK_PUBLISHABLE_KEY`

Add:
- `JWT_SECRET` — a random 256-bit secret (generate with `openssl rand -hex 32`)

## File Changes Summary

### Backend — New Files
- `backend/auth/passwords.py`
- `backend/auth/tokens.py`
- `backend/auth/dependencies.py`

### Backend — Modified Files
- `backend/auth/__init__.py` — re-export from dependencies.py instead of clerk.py
- `backend/routers/auth.py` — replace webhook with register/login/refresh
- `backend/db/models.py` — User model + all user_id columns
- `backend/routers/ai.py` — import path + type annotation (str → int)
- `backend/routers/apply.py` — import path + type annotation
- `backend/routers/connections.py` — import path + type annotation
- `backend/routers/fill.py` — import path + type annotation
- `backend/routers/jobs.py` — import path + type annotation
- `backend/routers/resumes.py` — import path + type annotation
- `backend/routers/settings.py` — import path + type annotation
- `backend/requirements.txt` — add `bcrypt`, remove Clerk-specific deps if any
- `backend/tests/conftest.py` — update test user ID to integer

### Backend — Deleted Files
- `backend/auth/clerk.py`

### Frontend — New Files
- `frontend/src/auth/AuthContext.tsx`
- `frontend/src/auth/AuthProvider.tsx`
- `frontend/src/auth/ProtectedRoute.tsx`
- `frontend/src/auth/useAuth.ts`
- `frontend/src/auth/api.ts`

### Frontend — Modified Files
- `frontend/src/main.tsx` — replace ClerkProvider with AuthProvider
- `frontend/src/App.tsx` — replace UserButton/useUser with useAuth
- `frontend/src/pages/SignIn.tsx` — custom login form
- `frontend/src/pages/SignUp.tsx` — custom registration form
- `frontend/src/pages/Landing.tsx` — replace useUser with useAuth
- `frontend/src/hooks/useAuthFetch.ts` — replace with import from auth/api.ts
- `frontend/src/pages/Jobs.tsx` — use new api client
- `frontend/src/pages/Resume.tsx` — use new api client
- `frontend/src/pages/ResumeDetail.tsx` — use new api client
- `frontend/src/pages/Settings.tsx` — use new api client
- `frontend/package.json` — remove @clerk/clerk-react

### Frontend — Deleted Files
- None (SignIn.tsx and SignUp.tsx are rewritten in-place)
