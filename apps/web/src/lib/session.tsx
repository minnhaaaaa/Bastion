import { createContext, useContext, useState, type ReactNode } from "react";
// Credentials live in memory only. Page transitions preserve this module, refresh clears it.
let operatorToken = "";
const Session = createContext({ token: "", setToken: (_token: string) => {} });
export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, update] = useState(operatorToken);
  return (
    <Session.Provider
      value={{
        token,
        setToken: (value) => {
          operatorToken = value;
          update(value);
        },
      }}
    >
      {children}
    </Session.Provider>
  );
}
export const useSession = () => useContext(Session);
