import { useState, useEffect, useCallback, ReactNode } from "react";
import { AuthContext, AuthContextValue, UserProfile } from "./AuthContext";
import api from "./api";

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!user;

  // On mount, check localStorage for tokens and validate by calling /auth/me
  useEffect(() => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      setIsLoading(false);
      return;
    }

    api
      .get("/auth/me")
      .then(({ data }) => {
        setUser(data);
      })
      .catch(() => {
        // Token invalid or expired (refresh interceptor already tried)
        localStorage.removeItem("access_token");
        localStorage.removeItem("refresh_token");
        setUser(null);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { data } = await api.post("/auth/login", { email, password });
    localStorage.setItem("access_token", data.access_token);
    localStorage.setItem("refresh_token", data.refresh_token);

    // Fetch user profile
    const { data: profile } = await api.get("/auth/me");
    setUser(profile);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const { data } = await api.post("/auth/register", { email, password });
    localStorage.setItem("access_token", data.access_token);
    localStorage.setItem("refresh_token", data.refresh_token);

    // Fetch user profile
    const { data: profile } = await api.get("/auth/me");
    setUser(profile);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    setUser(null);
    window.location.href = "/sign-in";
  }, []);

  const getToken = useCallback(() => {
    return localStorage.getItem("access_token");
  }, []);

  const value: AuthContextValue = {
    isAuthenticated,
    user,
    isLoading,
    login,
    register,
    logout,
    getToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
