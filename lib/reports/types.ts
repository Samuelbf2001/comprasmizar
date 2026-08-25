export interface ReportExpense { date: string; work: string; tag?: string; supplier?: string; origin: "requisicion" | "caja_menor"; base: number; iva: number; total: number; }
export interface OrderDocument { consecutive: string; type: "OC" | "OP"; work: string; supplier?: string; date: string; items: Array<{ description: string; quantity: number; unit: string; total: number }>; total: number; }
