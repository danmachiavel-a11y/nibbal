import { cn } from "@/lib/utils";

interface LoadingSpinnerProps {
  className?: string;
  size?: "sm" | "md" | "lg";
  message?: string;
}

const CuteCharacter = () => (
  <svg
    width="40"
    height="40"
    viewBox="0 0 40 40"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="animate-bounce"
  >
    <circle cx="20" cy="20" r="18" fill="#FFB6C1" />
    <circle cx="14" cy="16" r="3" fill="#333" /> {/* Left eye */}
    <circle cx="26" cy="16" r="3" fill="#333" /> {/* Right eye */}
    <path
      d="M15 25 Q20 28 25 25"
      stroke="#333"
      strokeWidth="2"
      strokeLinecap="round"
    /> {/* Smile */}
    <circle cx="20" cy="20" r="2" fill="#FFCDD2" className="animate-pulse" />
  </svg>
);

export function LoadingSpinner({
  className,
  size = "md",
  message = "Loading..."
}: LoadingSpinnerProps) {
  const sizeClasses = {
    sm: "w-16 h-16",
    md: "w-24 h-24",
    lg: "w-32 h-32"
  };

  return (
    <div className={cn("flex flex-col items-center justify-center gap-4", className)}>
      <div className="relative">
        <div className={cn(
          "rounded-full border-4 border-muted",
          "animate-[spin_3s_linear_infinite]",
          sizeClasses[size]
        )}>
          <CuteCharacter />
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="animate-pulse">✨</div>
        </div>
      </div>
      <p className="text-sm text-muted-foreground animate-pulse">{message}</p>
    </div>
  );
}
