import { createContext } from "react";

export interface UserProfile {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  profile_image_url?: string;
  created_at?: string;
  email_verified: boolean;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: UserProfile | null;
  isLoading: boolean;
}

export interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  loginWithGoogle: (credential: string) => Promise<void>;
  logout: () => void;
  getToken: () => string | null;
  resendVerification: () => Promise<void>;
  isEmailVerified: boolean;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);
