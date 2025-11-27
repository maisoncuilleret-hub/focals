import { MessageCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface LinkedInReplyBadgeProps {
  hasReply: boolean;
  className?: string;
}

export function LinkedInReplyBadge({ hasReply, className }: LinkedInReplyBadgeProps) {
  if (!hasReply) return null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-600 animate-pulse",
              className
            )}
          >
            <MessageCircle className="h-3 w-3" />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>Ce candidat a répondu sur LinkedIn !</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
