/** Web config comes from Vite env vars only. Missing config is a startup error, not a silent default. */
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required (see .env.example)`);
  return value;
}

export const env = {
  get apiUrl() {
    return required("VITE_API_URL", import.meta.env.VITE_API_URL);
  },
};
