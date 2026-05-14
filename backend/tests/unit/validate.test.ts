import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseBody } from "../../src/lib/validate";
import type { Request, Response } from "express";

function mockRes() {
    const res = {
        statusCode: 200,
        _body: undefined as unknown,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(body: unknown) {
            this._body = body;
            return this;
        },
    };
    return res as unknown as Response & { statusCode: number; _body: unknown };
}

function mockReq(body: unknown) {
    return { body } as Request;
}

const TestSchema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive().optional(),
});

describe("parseBody", () => {
    it("returns typed data on valid input", () => {
        const req = mockReq({ name: "Alice", age: 30 });
        const res = mockRes();
        const result = parseBody(TestSchema, req, res);
        expect(result).toEqual({ name: "Alice", age: 30 });
        expect(res.statusCode).toBe(200);
    });

    it("strips unknown fields (zod default strip behavior)", () => {
        const req = mockReq({ name: "Bob", extra: "should be gone" });
        const res = mockRes();
        const result = parseBody(TestSchema, req, res);
        expect(result).toEqual({ name: "Bob" });
        expect(result).not.toHaveProperty("extra");
    });

    it("returns null and sends 400 with fields on invalid input", () => {
        const req = mockReq({ name: "" }); // empty string fails min(1)
        const res = mockRes();
        const result = parseBody(TestSchema, req, res);
        expect(result).toBeNull();
        expect(res.statusCode).toBe(400);
        const body = res._body as { detail: string; fields: Record<string, string> };
        expect(body.detail).toBe("Validation failed");
        expect(body.fields).toHaveProperty("name");
    });

    it("returns null and sends 400 when body is missing required field", () => {
        const req = mockReq({});
        const res = mockRes();
        const result = parseBody(TestSchema, req, res);
        expect(result).toBeNull();
        expect(res.statusCode).toBe(400);
    });

    it("returns null when body is null", () => {
        const req = mockReq(null);
        const res = mockRes();
        const result = parseBody(TestSchema, req, res);
        expect(result).toBeNull();
        expect(res.statusCode).toBe(400);
    });
});
