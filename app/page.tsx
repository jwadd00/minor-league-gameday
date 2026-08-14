import type { Metadata } from "next";
import { GamedayApp } from "./GamedayApp";

export const metadata: Metadata = {
  title: "Minor League Gameday Scout",
  description:
    "Browse today's minor league games and discover where every player came from.",
};

export default function Home() {
  return <GamedayApp />;
}
