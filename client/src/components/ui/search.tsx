import React from "react";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SearchProps extends React.InputHTMLAttributes<HTMLInputElement> {
  onClear?: () => void;
  className?: string;
  showClearButton?: boolean;
}

export function Search({
  onClear,
  className,
  showClearButton = true,
  ...props
}: SearchProps) {
  const handleClear = () => {
    if (onClear) {
      onClear();
    }
  };

  return (
    <div className={cn("relative w-full", className)}>
      <Input
        className="pr-10"
        type="search"
        {...props}
      />
      {showClearButton && props.value && props.value.toString().length > 0 && (
        <Button
          onClick={handleClear}
          variant="ghost"
          size="sm"
          className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
          type="button"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Clear search</span>
        </Button>
      )}
    </div>
  );
}