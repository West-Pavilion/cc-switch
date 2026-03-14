import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionSearch } from "@/hooks/useSessionSearch";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Copy,
  RefreshCw,
  Search,
  Play,
  Download,
  Trash2,
  MessageSquare,
  Clock,
  FolderOpen,
  X,
} from "lucide-react";
import {
  useDeleteSessionMutation,
  useSessionMessagesQuery,
  useSessionsQuery,
} from "@/lib/query";
import { sessionsApi } from "@/lib/api";
import type { SessionMessage, SessionMeta } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { extractErrorMessage } from "@/utils/errorUtils";
import { isMac } from "@/lib/platform";
import { ProviderIcon } from "@/components/ProviderIcon";
import { SessionItem } from "./SessionItem";
import { SessionMessageItem } from "./SessionMessageItem";
import { SessionTocDialog, SessionTocSidebar } from "./SessionToc";
import {
  formatSessionTitle,
  formatTimestamp,
  getBaseName,
  getProviderIconName,
  getProviderLabel,
  getSessionKey,
} from "./utils";

type ProviderFilter =
  | "all"
  | "codex"
  | "claude"
  | "opencode"
  | "openclaw"
  | "gemini";

const DEFAULT_SESSION_EXPORT_EXTENSION = "md";

const sanitizeExportFileName = (value: string) =>
  value
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

const formatExportStamp = (date: Date) =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}_${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;

const createExportDefaultName = (session: SessionMeta, now: Date) => {
  const title = sanitizeExportFileName(formatSessionTitle(session))
    .replace(/\.+$/g, "")
    .slice(0, 48);
  const fallbackId = sanitizeExportFileName(session.sessionId).slice(0, 12);
  const prefix = title || fallbackId || "session";
  return `${prefix}-${formatExportStamp(now)}.${DEFAULT_SESSION_EXPORT_EXTENSION}`;
};

const buildSessionExportMarkdown = (
  session: SessionMeta,
  messages: SessionMessage[],
  exportedAt: Date,
) => {
  const lines: string[] = [];
  lines.push(`# ${formatSessionTitle(session)}`);
  lines.push("");
  lines.push(`- Provider: ${session.providerId}`);
  lines.push(`- Session ID: ${session.sessionId}`);
  if (session.projectDir) {
    lines.push(`- Project Dir: ${session.projectDir}`);
  }
  if (session.createdAt) {
    lines.push(`- Created At: ${new Date(session.createdAt).toISOString()}`);
  }
  const lastActive = session.lastActiveAt ?? session.createdAt;
  if (lastActive) {
    lines.push(`- Last Active At: ${new Date(lastActive).toISOString()}`);
  }
  lines.push(`- Exported At: ${exportedAt.toISOString()}`);
  lines.push(`- Message Count: ${messages.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  messages.forEach((message, index) => {
    lines.push(`## ${index + 1}. ${message.role}`);
    if (message.ts) {
      lines.push(`- Time: ${new Date(message.ts).toISOString()}`);
    }
    lines.push("");
    lines.push(message.content || "");
    lines.push("");
  });

  return lines.join("\n");
};

const buildSessionExportJson = (
  session: SessionMeta,
  messages: SessionMessage[],
  exportedAt: Date,
) =>
  JSON.stringify(
    {
      exportedAt: exportedAt.toISOString(),
      session,
      messageCount: messages.length,
      messages,
    },
    null,
    2,
  );

export function SessionManagerPage({ appId }: { appId: string }) {
  const { t } = useTranslation();
  const { data, isLoading, refetch: refetchSessions } = useSessionsQuery();
  const sessions = data ?? [];
  const detailRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [activeMessageIndex, setActiveMessageIndex] = useState<number | null>(
    null,
  );
  const [tocDialogOpen, setTocDialogOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionMeta | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>(
    appId as ProviderFilter,
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // 使用 FlexSearch 全文搜索
  const { search: searchSessions } = useSessionSearch({
    sessions,
    providerFilter,
  });

  const filteredSessions = useMemo(() => {
    return searchSessions(search);
  }, [searchSessions, search]);

  useEffect(() => {
    if (filteredSessions.length === 0) {
      setSelectedKey(null);
      return;
    }
    const exists = selectedKey
      ? filteredSessions.some(
          (session) => getSessionKey(session) === selectedKey,
        )
      : false;
    if (!exists) {
      setSelectedKey(getSessionKey(filteredSessions[0]));
    }
  }, [filteredSessions, selectedKey]);

  const selectedSession = useMemo(() => {
    if (!selectedKey) return null;
    return (
      filteredSessions.find(
        (session) => getSessionKey(session) === selectedKey,
      ) || null
    );
  }, [filteredSessions, selectedKey]);

  const {
    data: messages = [],
    isLoading: isLoadingMessages,
    refetch: refetchMessages,
  } =
    useSessionMessagesQuery(
      selectedSession?.providerId,
      selectedSession?.sourcePath,
    );
  const deleteSessionMutation = useDeleteSessionMutation();

  // 提取用户消息用于目录
  const userMessagesToc = useMemo(() => {
    return messages
      .map((msg, index) => ({ msg, index }))
      .filter(({ msg }) => msg.role.toLowerCase() === "user")
      .map(({ msg, index }) => ({
        index,
        preview:
          msg.content.slice(0, 50) + (msg.content.length > 50 ? "..." : ""),
        ts: msg.ts,
      }));
  }, [messages]);

  const scrollToMessage = (index: number) => {
    const el = messageRefs.current.get(index);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setActiveMessageIndex(index);
      setTocDialogOpen(false); // 关闭弹窗
      // 清除高亮状态
      setTimeout(() => setActiveMessageIndex(null), 2000);
    }
  };

  // 清理定时器
  useEffect(() => {
    return () => {
      // 这里的 setTimeout 其实无法直接清理，因为它在函数闭包里。
      // 如果要严格清理，需要用 useRef 存 timer id。
      // 但对于 2秒的高亮清除，通常不清理也没大问题。
      // 为了代码规范，我们在组件卸载时将 activeMessageIndex 重置 (虽然 React 会处理)
    };
  }, []);

  const handleCopy = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(successMessage);
    } catch (error) {
      toast.error(
        extractErrorMessage(error) ||
          t("common.error", { defaultValue: "Copy failed" }),
      );
    }
  };

  const handleResume = async () => {
    if (!selectedSession?.resumeCommand) return;

    if (!isMac()) {
      await handleCopy(
        selectedSession.resumeCommand,
        t("sessionManager.resumeCommandCopied"),
      );
      return;
    }

    try {
      await sessionsApi.launchTerminal({
        command: selectedSession.resumeCommand,
        cwd: selectedSession.projectDir ?? undefined,
      });
      toast.success(t("sessionManager.terminalLaunched"));
    } catch (error) {
      const fallback = selectedSession.resumeCommand;
      await handleCopy(fallback, t("sessionManager.resumeFallbackCopied"));
      toast.error(extractErrorMessage(error) || t("sessionManager.openFailed"));
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget?.sourcePath || deleteSessionMutation.isPending) {
      return;
    }

    setDeleteTarget(null);
    await deleteSessionMutation.mutateAsync({
      providerId: deleteTarget.providerId,
      sessionId: deleteTarget.sessionId,
      sourcePath: deleteTarget.sourcePath,
    });
  };

  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      const tasks: Array<Promise<unknown>> = [refetchSessions()];
      if (selectedSession?.providerId && selectedSession?.sourcePath) {
        tasks.push(refetchMessages());
      }
      await Promise.all(tasks);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleExport = async () => {
    if (isExporting || !selectedSession) return;

    const sessionToExport = selectedSession;
    const messagesToExport = messages;
    const exportedAt = new Date();

    setIsExporting(true);
    try {
      const defaultName = createExportDefaultName(sessionToExport, exportedAt);
      const destination = await sessionsApi.saveExportDialog(defaultName);
      if (!destination) return;

      const content = destination.toLowerCase().endsWith(".json")
        ? buildSessionExportJson(sessionToExport, messagesToExport, exportedAt)
        : buildSessionExportMarkdown(
            sessionToExport,
            messagesToExport,
            exportedAt,
          );

      await sessionsApi.exportTranscript({
        filePath: destination,
        content,
      });

      toast.success(
        `${t("sessionManager.exportSuccess", {
          defaultValue: "对话记录已导出",
        })}\n${destination}`,
        { closeButton: true },
      );
    } catch (error) {
      const detail = extractErrorMessage(error) || t("common.unknown");
      toast.error(
        t("sessionManager.exportFailed", {
          defaultValue: "导出会话失败: {{error}}",
          error: detail,
        }),
      );
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <TooltipProvider>
      <div className="mx-auto px-4 sm:px-6 flex flex-col h-[calc(100vh-8rem)]">
        <div className="flex-1 overflow-hidden flex flex-col gap-4">
          {/* 主内容区域 - 左右分栏 */}
          <div className="flex-1 overflow-hidden grid gap-4 md:grid-cols-[320px_1fr]">
            {/* 左侧会话列表 */}
            <Card className="flex flex-col overflow-hidden">
              <CardHeader className="py-2 px-3 border-b">
                {isSearchOpen ? (
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                    <Input
                      ref={searchInputRef}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={t("sessionManager.searchPlaceholder")}
                      className="h-8 pl-8 pr-8 text-sm"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setIsSearchOpen(false);
                          setSearch("");
                        }
                      }}
                      onBlur={() => {
                        if (search.trim() === "") {
                          setIsSearchOpen(false);
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 -translate-y-1/2 size-6"
                      onClick={() => {
                        setIsSearchOpen(false);
                        setSearch("");
                      }}
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-sm font-medium">
                        {t("sessionManager.sessionList")}
                      </CardTitle>
                      <Badge variant="secondary" className="text-xs">
                        {filteredSessions.length}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            onClick={() => {
                              setIsSearchOpen(true);
                              setTimeout(
                                () => searchInputRef.current?.focus(),
                                0,
                              );
                            }}
                          >
                            <Search className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {t("sessionManager.searchSessions")}
                        </TooltipContent>
                      </Tooltip>

                      <Select
                        value={providerFilter}
                        onValueChange={(value) =>
                          setProviderFilter(value as ProviderFilter)
                        }
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <SelectTrigger className="size-7 p-0 justify-center border-0 bg-transparent hover:bg-muted">
                              <ProviderIcon
                                icon={
                                  providerFilter === "all"
                                    ? "apps"
                                    : getProviderIconName(providerFilter)
                                }
                                name={providerFilter}
                                size={14}
                              />
                            </SelectTrigger>
                          </TooltipTrigger>
                          <TooltipContent>
                            {providerFilter === "all"
                              ? t("sessionManager.providerFilterAll")
                              : providerFilter}
                          </TooltipContent>
                        </Tooltip>
                        <SelectContent>
                          <SelectItem value="all">
                            <div className="flex items-center gap-2">
                              <ProviderIcon icon="apps" name="all" size={14} />
                              <span>
                                {t("sessionManager.providerFilterAll")}
                              </span>
                            </div>
                          </SelectItem>
                          <SelectItem value="codex">
                            <div className="flex items-center gap-2">
                              <ProviderIcon
                                icon="openai"
                                name="codex"
                                size={14}
                              />
                              <span>Codex</span>
                            </div>
                          </SelectItem>
                          <SelectItem value="claude">
                            <div className="flex items-center gap-2">
                              <ProviderIcon
                                icon="claude"
                                name="claude"
                                size={14}
                              />
                              <span>Claude Code</span>
                            </div>
                          </SelectItem>
                          <SelectItem value="opencode">
                            <div className="flex items-center gap-2">
                              <ProviderIcon
                                icon="opencode"
                                name="opencode"
                                size={14}
                              />
                              <span>OpenCode</span>
                            </div>
                          </SelectItem>
                          <SelectItem value="openclaw">
                            <div className="flex items-center gap-2">
                              <ProviderIcon
                                icon="openclaw"
                                name="openclaw"
                                size={14}
                              />
                              <span>OpenClaw</span>
                            </div>
                          </SelectItem>
                          <SelectItem value="gemini">
                            <div className="flex items-center gap-2">
                              <ProviderIcon
                                icon="gemini"
                                name="gemini"
                                size={14}
                              />
                              <span>Gemini CLI</span>
                            </div>
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            disabled={isRefreshing}
                            onClick={() => void handleRefresh()}
                          >
                            <RefreshCw
                              className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
                            />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("common.refresh")}</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                )}
              </CardHeader>
              <CardContent className="flex-1 overflow-hidden p-0">
                <ScrollArea className="h-full">
                  <div className="p-2">
                    {isLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <RefreshCw className="size-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : filteredSessions.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <MessageSquare className="size-8 text-muted-foreground/50 mb-2" />
                        <p className="text-sm text-muted-foreground">
                          {t("sessionManager.noSessions")}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {filteredSessions.map((session) => {
                          const isSelected =
                            selectedKey !== null &&
                            getSessionKey(session) === selectedKey;

                          return (
                            <SessionItem
                              key={getSessionKey(session)}
                              session={session}
                              isSelected={isSelected}
                              onSelect={setSelectedKey}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* 右侧会话详情 */}
            <Card
              className="flex flex-col overflow-hidden min-h-0"
              ref={detailRef}
            >
              {!selectedSession ? (
                <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
                  <MessageSquare className="size-12 mb-3 opacity-30" />
                  <p className="text-sm">{t("sessionManager.selectSession")}</p>
                </div>
              ) : (
                <>
                  {/* 详情头部 */}
                  <CardHeader className="py-3 px-4 border-b shrink-0">
                    <div className="flex items-start justify-between gap-4">
                      {/* 左侧：会话信息 */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="shrink-0">
                                <ProviderIcon
                                  icon={getProviderIconName(
                                    selectedSession.providerId,
                                  )}
                                  name={selectedSession.providerId}
                                  size={20}
                                />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {getProviderLabel(selectedSession.providerId, t)}
                            </TooltipContent>
                          </Tooltip>
                          <h2 className="text-base font-semibold truncate">
                            {formatSessionTitle(selectedSession)}
                          </h2>
                        </div>

                        {/* 元信息 */}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Clock className="size-3" />
                            <span>
                              {formatTimestamp(
                                selectedSession.lastActiveAt ??
                                  selectedSession.createdAt,
                              )}
                            </span>
                          </div>
                          {selectedSession.projectDir && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handleCopy(
                                      selectedSession.projectDir!,
                                      t("sessionManager.projectDirCopied"),
                                    )
                                  }
                                  className="flex items-center gap-1 hover:text-foreground transition-colors"
                                >
                                  <FolderOpen className="size-3" />
                                  <span className="truncate max-w-[200px]">
                                    {getBaseName(selectedSession.projectDir)}
                                  </span>
                                </button>
                              </TooltipTrigger>
                              <TooltipContent
                                side="bottom"
                                className="max-w-xs"
                              >
                                <p className="font-mono text-xs break-all">
                                  {selectedSession.projectDir}
                                </p>
                                <p className="text-muted-foreground mt-1">
                                  {t("sessionManager.clickToCopyPath")}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </div>

                      {/* 右侧：操作按钮组 */}
                      <div className="flex items-center gap-2 shrink-0">
                        {isMac() && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                size="sm"
                                className="gap-1.5"
                                onClick={() => void handleResume()}
                                disabled={!selectedSession.resumeCommand}
                              >
                                <Play className="size-3.5" />
                                <span className="hidden sm:inline">
                                  {t("sessionManager.resume", {
                                    defaultValue: "恢复会话",
                                  })}
                                </span>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {selectedSession.resumeCommand
                                ? t("sessionManager.resumeTooltip", {
                                    defaultValue: "在终端中恢复此会话",
                                  })
                                : t("sessionManager.noResumeCommand", {
                                    defaultValue: "此会话无法恢复",
                                  })}
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              className="gap-1.5 bg-blue-500 text-white hover:bg-blue-600 dark:bg-blue-600 dark:hover:bg-blue-700"
                              onClick={() => void handleRefresh()}
                              disabled={isRefreshing}
                            >
                              <RefreshCw
                                className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
                              />
                              <span className="hidden sm:inline">
                                {t("sessionManager.refreshSession", {
                                  defaultValue: "刷新会话",
                                })}
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.refreshSession", {
                              defaultValue: "刷新会话",
                            })}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5"
                              onClick={() => void handleExport()}
                              disabled={isExporting || isLoadingMessages}
                            >
                              <Download
                                className={`size-3.5 ${isExporting ? "animate-pulse" : ""}`}
                              />
                              <span className="hidden sm:inline">
                                {isExporting
                                  ? t("sessionManager.exporting", {
                                      defaultValue: "导出中...",
                                    })
                                  : t("sessionManager.export", {
                                      defaultValue: "导出会话",
                                    })}
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.exportTooltip", {
                              defaultValue: "导出当前会话记录",
                            })}
                          </TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="gap-1.5"
                              onClick={() => setDeleteTarget(selectedSession)}
                              disabled={
                                !selectedSession.sourcePath ||
                                deleteSessionMutation.isPending
                              }
                            >
                              <Trash2 className="size-3.5" />
                              <span className="hidden sm:inline">
                                {deleteSessionMutation.isPending
                                  ? t("sessionManager.deleting", {
                                      defaultValue: "删除中...",
                                    })
                                  : t("sessionManager.delete", {
                                      defaultValue: "删除会话",
                                    })}
                              </span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.deleteTooltip", {
                              defaultValue: "永久删除此本地会话记录",
                            })}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>

                    {/* 恢复命令预览 */}
                    {selectedSession.resumeCommand && (
                      <div className="mt-3 flex items-center gap-2">
                        <div className="flex-1 rounded-md bg-muted/60 px-3 py-1.5 font-mono text-xs text-muted-foreground truncate">
                          {selectedSession.resumeCommand}
                        </div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              onClick={() =>
                                void handleCopy(
                                  selectedSession.resumeCommand!,
                                  t("sessionManager.resumeCommandCopied"),
                                )
                              }
                            >
                              <Copy className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("sessionManager.copyCommand", {
                              defaultValue: "复制命令",
                            })}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    )}
                  </CardHeader>

                  {/* 消息列表区域 */}
                  <CardContent className="flex-1 overflow-hidden p-0">
                    <div className="flex h-full min-w-0">
                      {/* 消息列表 */}
                      <ScrollArea className="flex-1 min-w-0">
                        <div className="p-4 min-w-0">
                          <div className="flex items-center gap-2 mb-3">
                            <MessageSquare className="size-4 text-muted-foreground" />
                            <span className="text-sm font-medium">
                              {t("sessionManager.conversationHistory", {
                                defaultValue: "对话记录",
                              })}
                            </span>
                            <Badge variant="secondary" className="text-xs">
                              {messages.length}
                            </Badge>
                          </div>

                          {isLoadingMessages ? (
                            <div className="flex items-center justify-center py-12">
                              <RefreshCw className="size-5 animate-spin text-muted-foreground" />
                            </div>
                          ) : messages.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-12 text-center">
                              <MessageSquare className="size-8 text-muted-foreground/50 mb-2" />
                              <p className="text-sm text-muted-foreground">
                                {t("sessionManager.emptySession")}
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {messages.map((message, index) => (
                                <SessionMessageItem
                                  key={`${message.role}-${index}`}
                                  message={message}
                                  index={index}
                                  isActive={activeMessageIndex === index}
                                  setRef={(el) => {
                                    if (el) messageRefs.current.set(index, el);
                                  }}
                                  onCopy={(content) =>
                                    handleCopy(
                                      content,
                                      t("sessionManager.messageCopied", {
                                        defaultValue: "已复制消息内容",
                                      }),
                                    )
                                  }
                                />
                              ))}
                              <div ref={messagesEndRef} />
                            </div>
                          )}
                        </div>
                      </ScrollArea>

                      {/* 右侧目录 - 类似少数派 (大屏幕) */}
                      <SessionTocSidebar
                        items={userMessagesToc}
                        onItemClick={scrollToMessage}
                      />
                    </div>

                    {/* 浮动目录按钮 (小屏幕) */}
                    <SessionTocDialog
                      items={userMessagesToc}
                      onItemClick={scrollToMessage}
                      open={tocDialogOpen}
                      onOpenChange={setTocDialogOpen}
                    />
                  </CardContent>
                </>
              )}
            </Card>
          </div>
        </div>
      </div>
      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        title={t("sessionManager.deleteConfirmTitle", {
          defaultValue: "删除会话",
        })}
        message={
          deleteTarget
            ? t("sessionManager.deleteConfirmMessage", {
                defaultValue:
                  "将永久删除本地会话“{{title}}”\nSession ID: {{sessionId}}\n\n此操作不可恢复。",
                title: formatSessionTitle(deleteTarget),
                sessionId: deleteTarget.sessionId,
              })
            : ""
        }
        confirmText={t("sessionManager.deleteConfirmAction", {
          defaultValue: "删除会话",
        })}
        cancelText={t("common.cancel", { defaultValue: "取消" })}
        variant="destructive"
        onConfirm={() => void handleDeleteConfirm()}
        onCancel={() => {
          if (!deleteSessionMutation.isPending) {
            setDeleteTarget(null);
          }
        }}
      />
    </TooltipProvider>
  );
}
