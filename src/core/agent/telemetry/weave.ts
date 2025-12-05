import type { Session } from "../sessions";
import weave from "weave";

// Env-driven gate
const WEAVE_PROJECT = process.env.PENSAR_WEAVE_PROJECT ?? "pensar/apex-research";
const WEAVE_API_KEY = process.env.PENSAR_WEAVE_API_KEY;
const WEAVE_ENABLED = !!(WEAVE_PROJECT && WEAVE_API_KEY);

let weaveInitPromise: Promise<void> | null = null;

async function ensureWeaveInit() {
  if (!WEAVE_ENABLED) return;
  if (!weaveInitPromise) {
    weaveInitPromise = (async () => {
      // Safe guard: only init once
      // Set the API key in environment for Weave SDK
      if (WEAVE_API_KEY) {
        process.env.WANDB_API_KEY = WEAVE_API_KEY;
      }
      await weave.init(WEAVE_PROJECT);
    })();
  }
  return weaveInitPromise;
}

// --- Types you'll reuse across agents/tools ---

export type AgentTraceContext = {
  traceName: string;        // e.g. "thorough-pentest_stream"
  agentType: string;        // e.g. "thorough-pentest"
  model: string;
  session: Session;
  target: string;
  objective: string;
  parentTraceId?: string;
  extra?: Record<string, any>;
};

export type StepPayload = {
  stepIndex: number;
  stepType: "tool" | "thought" | "message" | "other";
  rawStep: any;
};

export type ToolCallPayload = {
  toolName: string;
  args: any;
  result?: any;
};

// This is a simple context handle we pass around
export type TraceHandle = {
  enabled: boolean;
  opName: string;
  traceId?: string;
  callId?: string; // Weave call ID for parent-child relationships
  // Helper to wrap child operations so they nest under the parent
  wrapOp?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  meta: {
    agentType: string;
    sessionId: string;
    target: string;
    companyId?: string;
  };
};

// --- Start / end agent traces ---

export async function startAgentTrace(ctx: AgentTraceContext): Promise<TraceHandle> {
  if (!WEAVE_ENABLED) {
    return {
      enabled: false,
      opName: ctx.traceName,
      meta: {
        agentType: ctx.agentType,
        sessionId: ctx.session.id,
        target: ctx.target,
        companyId: (ctx.session as any).companyId,
      },
    };
  }

  await ensureWeaveInit();

  const meta = {
    model: ctx.model,
    agentType: ctx.agentType,
    sessionId: ctx.session.id,
    target: ctx.target,
    objective: ctx.objective,
    companyId: (ctx.session as any).companyId,
    rootPath: ctx.session.rootPath,
    parentTraceId: ctx.parentTraceId ?? null,
    ...ctx.extra,
  };

  let callId: string | undefined;

  try {
    // Use weave.op to create a traced function with call tracking
    const tracedFn = weave.op(
      async function agentRun(input: any) {
        // This function will be traced by Weave
        return { started: true, ...input };
      },
      { name: ctx.traceName }
    );

    // Call it and get the call reference for nesting
    const result = await tracedFn(meta);

    // Try to get the call ID if available
    if (result && typeof result === 'object' && 'id' in result) {
      callId = (result as any).id;
    }

    // Create a helper that wraps child operations with weave.op
    // This ensures they get tracked as nested operations
    const wrapOp = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
      const childOp = weave.op(fn, { name });
      return await childOp();
    };

    return {
      enabled: true,
      opName: ctx.traceName,
      callId,
      wrapOp,
      meta: {
        agentType: ctx.agentType,
        sessionId: ctx.session.id,
        target: ctx.target,
        companyId: (ctx.session as any).companyId,
      },
    };
  } catch (error) {
    // Silent fail to not break execution
    return {
      enabled: false,
      opName: ctx.traceName,
      meta: {
        agentType: ctx.agentType,
        sessionId: ctx.session.id,
        target: ctx.target,
        companyId: (ctx.session as any).companyId,
      },
    };
  }
}

export async function endAgentTrace(
  handle: TraceHandle,
  payload: {
    input: any;
    output: any;
    stats?: {
      toolCount?: number;
      stepCount?: number;
      durationMs?: number;
      tokenUsage?: any;
    };
  }
): Promise<void> {
  if (!WEAVE_ENABLED || !handle.enabled) return;
  await ensureWeaveInit();

  try {
    const tracedFn = weave.op(
      async function (data: any) {
        return data;
      },
      { name: `${handle.opName}_complete` }
    );

    await tracedFn({
      meta: handle.meta,
      input: payload.input,
      output: payload.output,
      stats: payload.stats ?? {},
    });
  } catch (error) {
    // Silent fail
  }
}

// --- Step-level logging (hook from onStepFinish) ---

export async function recordStep(handle: TraceHandle, step: StepPayload): Promise<void> {
  if (!WEAVE_ENABLED || !handle.enabled) return;
  await ensureWeaveInit();

  try {
    // Use wrapOp if available for proper nesting, otherwise create standalone op
    if (handle.wrapOp) {
      await handle.wrapOp(`${handle.opName}_step_${step.stepIndex}`, async () => {
        return {
          stepIndex: step.stepIndex,
          stepType: step.stepType,
          rawStep: step.rawStep,
        };
      });
    } else {
      const tracedFn = weave.op(
        async function step(data: any) {
          return data;
        },
        { name: `${handle.opName}_step_${step.stepIndex}` }
      );

      await tracedFn({
        parent: handle.opName,
        parentCallId: handle.callId,
        parentMeta: handle.meta,
        stepIndex: step.stepIndex,
        stepType: step.stepType,
        rawStep: step.rawStep,
      });
    }
  } catch (error) {
    // Silent fail
  }
}

// --- Tool-level logging (called from agent/tools.ts) ---

export async function recordToolCall(
  handle: TraceHandle | null,
  payload: ToolCallPayload
): Promise<void> {
  if (!WEAVE_ENABLED || !handle?.enabled) return;
  await ensureWeaveInit();

  try {
    // Use wrapOp if available for proper nesting, otherwise create standalone op
    if (handle.wrapOp) {
      await handle.wrapOp(`${handle.opName}_tool_${payload.toolName}`, async () => {
        return {
          toolName: payload.toolName,
          args: payload.args,
          result: payload.result,
        };
      });
    } else {
      const tracedFn = weave.op(
        async function tool(data: any) {
          return data;
        },
        { name: `${handle.opName}_tool_${payload.toolName}` }
      );

      await tracedFn({
        parent: handle.opName,
        parentCallId: handle.callId,
        parentMeta: handle.meta,
        toolName: payload.toolName,
        args: payload.args,
        result: payload.result,
      });
    }
  } catch (error) {
    // Silent fail
  }
}
