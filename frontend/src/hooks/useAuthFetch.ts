import { useAuth } from "@clerk/clerk-react";
import axios from "axios";
import { useMemo } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

/**
 * Returns an axios instance that automatically attaches the Clerk JWT
 * as a Bearer token to every request.
 */
export function useAuthAxios() {
  const { getToken } = useAuth();

  const authAxios = useMemo(() => {
    const instance = axios.create({ baseURL: API_BASE });

    instance.interceptors.request.use(async (config) => {
      const token = await getToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    return instance;
  }, [getToken]);

  return authAxios;
}
