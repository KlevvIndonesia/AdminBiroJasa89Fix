/**
 * Employee Routes (Secured & Validated)
 * Admin SUN89 — Biro Jasa Management System
 */

import { Router } from "express";
import {
  getEmployees,
  getEmployeeById,
  getNextEmployeeId,
  createEmployee,
  updateEmployee,
  deleteEmployee,
} from "../controllers/employeeController";
import { requireAuth, requireRoles, requirePermission } from "../middleware/auth";

export const employeeRouter = Router();

// List all employees (Administrator & Admin only, dynamic permission gated)
employeeRouter.get(
  "/",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-karyawan", "view"),
  getEmployees
);

// Get next available Employee ID format (e.g. EMP-0007)
employeeRouter.get(
  "/next-id",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-karyawan", "view"),
  getNextEmployeeId
);

// Get employee by ID
employeeRouter.get(
  "/:id",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-karyawan", "view"),
  getEmployeeById
);

// Create employee
employeeRouter.post(
  "/",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-karyawan", "manage"),
  createEmployee
);

// Update employee
employeeRouter.put(
  "/:id",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-karyawan", "manage"),
  updateEmployee
);

// Delete employee
employeeRouter.delete(
  "/:id",
  requireAuth,
  requireRoles("administrator", "admin"),
  requirePermission("manajemen-karyawan", "manage"),
  deleteEmployee
);
