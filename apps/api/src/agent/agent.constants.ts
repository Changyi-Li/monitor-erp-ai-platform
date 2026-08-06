/** 编译后 LangGraph 图的注入令牌（独立文件避免 agent.module ↔ agent.service 循环导入） */
export const AGENT_GRAPH = Symbol('AGENT_GRAPH');
