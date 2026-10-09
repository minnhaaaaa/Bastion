/** Web config comes from Vite env vars only. Missing config is a startup error, not a silent default. */
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required (see .env.example)`);
  return value;
}

export const env = {
  get apiUrl() {
    const configured = required("VITE_API_URL", import.meta.env.VITE_API_URL);
    // Vite forwards API and socket traffic to the explicitly configured controller.
    // Development browsers use their own origin, including localhost/127.0.0.1 aliases.
    return import.meta.env.DEV ? window.location.origin : configured;
  },
};
