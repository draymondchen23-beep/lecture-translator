import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Lecture — Real-time Translation & Notes",
  description: "Real-time English lecture transcription, Chinese translation and structured revision notes.",
};

export default function LectureTranslatorLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
