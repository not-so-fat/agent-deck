import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// tailwind-merge 3 no longer lets a font-size class (text-xl) drop an earlier
// line-height class (leading-none). Our primitives (DialogTitle, CardTitle,
// Label) set leading-none and callers override the size, so keep the v2 rule
// to preserve the existing look.
const twMerge = extendTailwindMerge({
  extend: {
    conflictingClassGroups: {
      "font-size": ["leading"],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
