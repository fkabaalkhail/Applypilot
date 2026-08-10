import axios from "axios";

const API_BASE = import.meta.env.VITE_API_URL || "";

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true, // Send cookies with all requests
});

/**
 * True when the app is running inside the extension's /embed/* iframe. There we
 * must NEVER navigate to /sign-in or /verify-email: the modal authenticates via
 * the extension's own token (passed over a MessageChannel), not a web session,
 * so a web-session 401 is expected and must not hijack the iframe.
 */
export function isEmbedded(): boolean {
  try {
    if (window.location.pathname.startsWith("/embed")) return true;
    return window.self !== window.top;
  } catch {
    return true; // cross-origin frame access throws → we are framed
  }
}

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

    // Handle 403 "Email verification required", redirect to verify page
    if (
      error.response?.status === 403 &&
      error.response?.data?.detail === "Email verification required"
    ) {
      if (!isEmbedded()) window.location.href = "/verify-email";
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        // Refresh token is sent automatically via HttpOnly cookie
        const { data } = await axios.post(
          `${API_BASE}/auth/refresh`,
          {},
          { withCredentials: true }
        );
        localStorage.setItem("access_token", data.access_token);
        originalRequest.headers.Authorization = `Bearer ${data.access_token}`;
        return api(originalRequest);
      } catch {
        localStorage.removeItem("access_token");
        // In the extension embed the modal has its own token, don't hijack the
        // iframe to /sign-in; let the caller (embed axios) handle the 401.
        if (!isEmbedded()) window.location.href = "/sign-in";
      }
    }
    return Promise.reject(error);
  }
);

export default api;
